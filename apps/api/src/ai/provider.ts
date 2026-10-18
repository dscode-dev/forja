import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { object } from '../identity/validation';
import {
  AiFailure,
  Context,
  context,
  instructions,
  outputSchema,
} from './model';
export const AI_PROVIDER = Symbol('AI_PROVIDER');
export const MODEL = 'gpt-5.4-mini-2026-03-17';
export const ENDPOINT = 'https://api.openai.com/v1/responses';
export interface ProviderResult {
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  requestId: string | null;
  durationMs: number;
}
export interface AiProvider {
  available(): boolean;
  run(c: Context, signal: AbortSignal): Promise<ProviderResult>;
}
export interface ProviderSettings {
  enabled: boolean;
  approvalFile: string;
  keyFile: string;
}
export function settings(
  env: NodeJS.ProcessEnv = process.env,
): ProviderSettings {
  return {
    enabled: env['AI_PROVIDER_ENABLED'] === 'true',
    approvalFile:
      env['AI_APPROVAL_FILE'] ?? '/run/forja-ai/provider-approval.json',
    keyFile: env['AI_OPENAI_KEY_FILE'] ?? '/run/forja-ai/openai-key',
  };
}
function file(path: string, max: number) {
  if (!isAbsolute(path)) throw new AiFailure('CONFIGURATION');
  const b = readFileSync(path);
  try {
    if (b.length < 1 || b.length > max) throw new AiFailure('CONFIGURATION');
    return b.toString('utf8').trim();
  } finally {
    b.fill(0);
  }
}
export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly config: ProviderSettings = settings(),
    private readonly transport: typeof fetch = fetch,
  ) {}
  private approval() {
    if (!this.config.enabled) throw new AiFailure('CONFIGURATION');
    try {
      if (process.env['OPENAI_API_KEY']) throw new Error();
      const b = object(
        JSON.parse(file(this.config.approvalFile, 4096)) as unknown,
        [
          'schema',
          'provider',
          'endpoint',
          'model',
          'project',
          'noTraining',
          'zeroDataRetention',
          'regionsReviewed',
          'subprocessorsReviewed',
          'reviewedAt',
          'expiresAt',
          'evidenceReference',
        ],
      );
      if (
        b['schema'] !== 1 ||
        b['provider'] !== 'openai' ||
        b['endpoint'] !== ENDPOINT ||
        b['model'] !== MODEL ||
        typeof b['project'] !== 'string' ||
        !/^proj_[A-Za-z0-9_-]{4,120}$/u.test(b['project']) ||
        b['noTraining'] !== true ||
        b['zeroDataRetention'] !== true ||
        b['regionsReviewed'] !== true ||
        b['subprocessorsReviewed'] !== true ||
        typeof b['evidenceReference'] !== 'string' ||
        !/^[A-Za-z0-9._:/-]{1,160}$/u.test(b['evidenceReference'])
      )
        throw new Error();
      const from = Date.parse(String(b['reviewedAt'])),
        until = Date.parse(String(b['expiresAt']));
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(until) ||
        from > Date.now() ||
        until <= Date.now() ||
        until - from > 30 * 86400000
      )
        throw new Error();
      return { project: b['project'] };
    } catch {
      throw new AiFailure('CONFIGURATION');
    }
  }
  available() {
    try {
      this.approval();
      const key = file(this.config.keyFile, 4096);
      return /^sk-[A-Za-z0-9_-]{16,400}$/u.test(key);
    } catch {
      return false;
    }
  }
  async run(raw: Context, signal: AbortSignal): Promise<ProviderResult> {
    const c = context(raw),
      a = this.approval();
    let key: string;
    try {
      key = file(this.config.keyFile, 4096);
      if (!/^sk-[A-Za-z0-9_-]{16,400}$/u.test(key)) throw new Error();
    } catch {
      throw new AiFailure('CONFIGURATION');
    }
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const start = performance.now(),
      timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.transport(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'OpenAI-Project': a.project,
          'X-Client-Request-Id': randomUUID(),
        },
        body: JSON.stringify({
          model: MODEL,
          store: false,
          background: false,
          stream: false,
          tools: [],
          tool_choice: 'none',
          reasoning: { effort: 'none' },
          max_output_tokens: 900,
          instructions,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: JSON.stringify(c) }],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'forja_alquimista_v1',
              strict: true,
              schema: outputSchema,
            },
          },
        }),
      });
      key = '';
      if (!response.ok) {
        await response.body?.cancel();
        throw new AiFailure(
          response.status === 429
            ? 'RATE_LIMIT'
            : response.status === 401 || response.status === 403
              ? 'CONFIGURATION'
              : 'UNAVAILABLE',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AiFailure('INVALID_OUTPUT');
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          total += r.value.length;
          if (total > 65536) throw new AiFailure('INVALID_OUTPUT');
          chunks.push(r.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        throw new AiFailure('INVALID_OUTPUT');
      }
      if (
        b['status'] !== 'completed' ||
        b['model'] !== MODEL ||
        !Array.isArray(b['output']) ||
        b['output'].length !== 1
      )
        throw new AiFailure('INVALID_OUTPUT');
      const message = b['output'][0] as Record<string, unknown>;
      if (
        message['type'] !== 'message' ||
        !Array.isArray(message['content']) ||
        message['content'].length !== 1
      )
        throw new AiFailure('INVALID_OUTPUT');
      const part = message['content'][0] as Record<string, unknown>;
      if (part['type'] === 'refusal') throw new AiFailure('REFUSAL');
      if (
        part['type'] !== 'output_text' ||
        typeof part['text'] !== 'string' ||
        Buffer.byteLength(part['text']) > 8192
      )
        throw new AiFailure('INVALID_OUTPUT');
      const usage = b['usage'] as Record<string, unknown> | undefined;
      const inputTokens = usage?.['input_tokens'],
        outputTokens = usage?.['output_tokens'];
      if (
        !Number.isSafeInteger(inputTokens) ||
        Number(inputTokens) < 0 ||
        Number(inputTokens) > 6000 ||
        !Number.isSafeInteger(outputTokens) ||
        Number(outputTokens) < 0 ||
        Number(outputTokens) > 900
      )
        throw new AiFailure('INVALID_OUTPUT');
      let value: unknown;
      try {
        value = JSON.parse(part['text']);
      } catch {
        throw new AiFailure('INVALID_OUTPUT');
      }
      const request = response.headers.get('x-request-id');
      return {
        value,
        inputTokens: Number(inputTokens),
        outputTokens: Number(outputTokens),
        requestId:
          request && /^req_[A-Za-z0-9_-]{1,120}$/u.test(request)
            ? request
            : null,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (e) {
      if (e instanceof AiFailure) throw e;
      if (controller.signal.aborted)
        throw new AiFailure(signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      throw new AiFailure('UNAVAILABLE');
    } finally {
      key = '';
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
