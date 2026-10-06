using System;
using Forja.Application;
using Forja.Core;
using UnityEngine;
using UnityEngine.UIElements;
using Unity.Profiling;

namespace Forja.Presentation
{
    public sealed class ForjaShell
    {
        private static readonly ProfilerMarker RenderMarker = new ProfilerMarker("Forja.UI.Render");
        private readonly VisualElement root;
        private readonly ShellNavigation navigation;
        private readonly Action<string> login;
        private readonly Action refresh;
        private readonly Action<bool> logout;
        private readonly PresentationArt art;
        private SessionCoordinator session;
        private bool configurationError;
        public ForjaShell(VisualElement root, ShellNavigation navigation, Action<string> login, Action refresh, Action<bool> logout)
        {
            this.root = root; this.navigation = navigation; this.login = login; this.refresh = refresh; this.logout = logout;
            art = Resources.Load<PresentationArt>("UI/PresentationArt");
            root.AddToClassList("shell"); root.styleSheets.Add(Resources.Load<StyleSheet>("UI/ForjaShell"));
        }
        public void Render(SessionCoordinator value, bool failed)
        {
            using (RenderMarker.Auto()) RenderContent(value, failed);
        }
        private void RenderContent(SessionCoordinator value, bool failed)
        {
            session = value; configurationError = failed;
            navigation.SessionChanged(value == null ? SessionState.FATAL_CONFIGURATION_ERROR : value.State, value?.Snapshot != null);
            root.Clear();
            root.style.fontSize = 17 * navigation.TextScale;
            root.EnableInClassList("large-text", navigation.TextScale > 1);
            var header = new VisualElement(); header.AddToClassList("header");
            header.Add(ShellComponents.Text("Forja", "brand"));
            bool authenticated = value?.State == SessionState.AUTHENTICATED && value.Snapshot != null;
            if (authenticated) header.Add(ShellComponents.Action(navigation.HiddenValues ? "Mostrar valores" : "Ocultar valores", () => { navigation.ToggleValues(); Redraw(); }, true, "quiet"));
            root.Add(header);
            var scroll = new ScrollView(ScrollViewMode.Vertical); scroll.AddToClassList("content"); root.Add(scroll);
            if (failed || value == null || value.State == SessionState.FATAL_CONFIGURATION_ERROR)
            {
                Welcome(scroll);
                scroll.Add(ShellComponents.State("Conexão em preparação", "A conexão do aplicativo ainda precisa ser configurada."));
                scroll.Add(ShellComponents.Text("Seu espaço está pronto para começar. Os dados financeiros aparecerão após uma conexão segura.", "caption"));
                return;
            }
            if (value.Busy)
            {
                scroll.Add(ShellComponents.State("Preparando seu caminho", value.State == SessionState.AUTHENTICATING ? "Conclua sua entrada na janela segura." : "Carregando…"));
                return;
            }
            if (value.Error.HasValue) scroll.Add(ShellComponents.State("Precisamos tentar novamente", FailureMessage(value.Error.Value)));
            if (!authenticated)
            {
                Welcome(scroll);
                if (value.CanLogin)
                {
                    scroll.Add(ShellComponents.Action("Entrar no meu caminho", () => login("login")));
                    scroll.Add(ShellComponents.Action("Criar minha conta", () => login("register"), true, "quiet"));
                }
                else scroll.Add(ShellComponents.State("Entrada segura em preparação", "A autenticação ainda não está disponível neste ambiente."));
                scroll.Add(ShellComponents.Action("Tentar conexão novamente", refresh));
                if (value.State == SessionState.DEGRADED || value.State == SessionState.SESSION_EXPIRED)
                    scroll.Add(ShellComponents.Action("Sair deste dispositivo", () => logout(false), true, "quiet"));
                return;
            }
            var snapshot = value.Snapshot;
            switch (navigation.Destination)
            {
                case ShellDestination.Home: Home(scroll, snapshot); break;
                case ShellDestination.Goals: Goals(scroll, snapshot); break;
                case ShellDestination.Accounts: Accounts(scroll, snapshot); break;
                case ShellDestination.Work: Work(scroll, snapshot); break;
                case ShellDestination.Reports:
                    scroll.Add(ShellComponents.State("Crônicas do seu caminho", "Os relatórios ainda não estão disponíveis. Eles serão construídos a partir do seu histórico financeiro real.")); break;
                case ShellDestination.Profile: Profile(scroll); break;
            }
            Nav();
        }
        private void Redraw() => Render(session, configurationError);
        private void Go(ShellDestination destination) { navigation.Go(destination); Redraw(); }
        private void Welcome(VisualElement parent)
        {
            parent.Add(ShellComponents.Text("Seu amanhã começa com um passo", "hero-title"));
            parent.Add(new CharacterPresentation(art, null, true));
            parent.Add(ShellComponents.Text("A vida real move a sua jornada. Você escolhe o ritmo."));
            parent.Add(ShellComponents.Action("Conhecer as apresentações", ShowCatalogue, art != null, "quiet"));
        }
        private void Home(VisualElement parent, ShellSnapshot snapshot)
        {
            parent.Add(ShellComponents.Text(snapshot.Name == null ? "Seu espaço, seu caminho" : "Olá, " + snapshot.Name, "hero-title"));
            parent.Add(new CharacterPresentation(art, navigation.CharacterId, navigation.ReducedMotion));
            if (navigation.CharacterId == null) parent.Add(ShellComponents.Action("Escolher minha presença", () => Go(ShellDestination.Profile), true, "quiet"));
            var finances = ShellComponents.Panel("Onde você está hoje", "VIDA FINANCEIRA");
            if (snapshot.Accounts.Count == 0) finances.Add(ShellComponents.Text("Você ainda não tem contas cadastradas."));
            else
            {
                var account = snapshot.Accounts[0]; finances.Add(ShellComponents.Text(account.Name));
                ShellComponents.Value(finances, FinancialLabels.Title(FinancialMeaning.Settled) + " · desta conta", account.Balance, navigation.HiddenValues);
                finances.Add(ShellComponents.Text("Sem soma entre contas ou moedas.", "caption"));
            }
            finances.Add(ShellComponents.Action("Ver minhas contas", () => Go(ShellDestination.Accounts), true, "quiet")); parent.Add(finances);
            var goals = ShellComponents.Panel("Um objetivo à vista", "METAS");
            if (snapshot.Goals.Count == 0) goals.Add(ShellComponents.Text("Você ainda não tem metas cadastradas."));
            else { goals.Add(ShellComponents.Text(snapshot.Goals[0].Title)); ShellComponents.Value(goals, "Restante · calculado pelo servidor", snapshot.Goals[0].Remaining, navigation.HiddenValues); }
            goals.Add(ShellComponents.Action("Ver minhas metas", () => Go(ShellDestination.Goals), true, "quiet")); parent.Add(goals);
            var work = ShellComponents.Panel("Seu tempo, suas possibilidades", "TRABALHO");
            work.Add(ShellComponents.Text(snapshot.Work == null ? "Você ainda não tem perfil profissional cadastrado." : snapshot.Work.Occupation));
            work.Add(ShellComponents.Action("Ver capacidade declarada", () => Go(ShellDestination.Work), true, "quiet")); parent.Add(work);
            parent.Add(ShellComponents.Action("Minha jornada", () => ShowSheet("Sua jornada", "Missões e progressão ainda não estão disponíveis. A experiência virtual nunca altera seu dinheiro real."), true, "quiet"));
        }
        private void Accounts(VisualElement parent, ShellSnapshot snapshot)
        {
            Back(parent, "Minhas contas");
            if (snapshot.Accounts.Count == 0) parent.Add(ShellComponents.State("Comece pelo que é real", "Você ainda não tem contas cadastradas."));
            foreach (var account in snapshot.Accounts)
            {
                var card = ShellComponents.Panel(account.Name); card.Add(ShellComponents.Status(account.State == "active" ? "Conta ativa" : "Conta encerrada"));
                ShellComponents.Value(card, FinancialLabels.Title(FinancialMeaning.Settled), account.Balance, navigation.HiddenValues); parent.Add(card);
            }
            var expectations = ShellComponents.Panel("Realizado e futuro são diferentes", "PREVISÃO · PRIMEIRA CONTA");
            var forecast = snapshot.Forecast;
            if (forecast == null) expectations.Add(ShellComponents.Text("A previsão não está disponível nesta consulta."));
            else
            {
                expectations.Add(ShellComponents.Text(forecast.AccountName));
                expectations.Add(ShellComponents.Text("Consulta: " + forecast.AsOf + "\nAté: " + forecast.Through + " · UTC", "caption"));
                ShellComponents.Value(expectations, FinancialLabels.Title(FinancialMeaning.Projected), forecast.Projected, navigation.HiddenValues);
                ShellComponents.Value(expectations, FinancialLabels.Title(FinancialMeaning.Receivable), forecast.Receivable, navigation.HiddenValues);
                ShellComponents.Value(expectations, FinancialLabels.Title(FinancialMeaning.Payable), forecast.Payable, navigation.HiddenValues);
                ShellComponents.Value(expectations, "Renda prevista · ainda não recebida", forecast.PredictedIncome, navigation.HiddenValues);
                ShellComponents.Value(expectations, "Débito agendado · ainda não concluído", forecast.ScheduledDebit, navigation.HiddenValues);
                expectations.Add(ShellComponents.Text("Retrato separado da consulta de contas; não representa uma atualização simultânea de todos os dados.", "caption"));
            }
            expectations.Add(ShellComponents.Text("Renda prevista não é renda recebida. Débito agendado não é pagamento concluído.", "caption")); parent.Add(expectations);
            PageNotice(parent, snapshot.AccountNext);
        }
        private void Goals(VisualElement parent, ShellSnapshot snapshot)
        {
            parent.Add(ShellComponents.Text("Metas para o seu amanhã", "hero-title"));
            if (snapshot.Goals.Count == 0) parent.Add(ShellComponents.State("Um caminho de cada vez", "Você ainda não tem metas cadastradas."));
            foreach (var goal in snapshot.Goals) parent.Add(ShellComponents.Goal(goal, navigation.HiddenValues));
            PageNotice(parent, snapshot.GoalNext);
        }
        private void Work(VisualElement parent, ShellSnapshot snapshot)
        {
            Back(parent, "Trabalho e capacidade");
            if (snapshot.Work == null) { parent.Add(ShellComponents.State("Suas possibilidades", "Você ainda não tem perfil profissional cadastrado.")); return; }
            var work = snapshot.Work; var panel = ShellComponents.Panel(work.Occupation);
            panel.Add(ShellComponents.Text(work.From + " a " + work.Through + " · UTC", "caption"));
            if (work.Estimate == null) panel.Add(ShellComponents.Status("Estimativa total indisponível"));
            else ShellComponents.Value(panel, FinancialLabels.Title(FinancialMeaning.WorkCapacity), work.Estimate, navigation.HiddenValues);
            panel.Add(ShellComponents.Text("Não representa renda recebida. Base: seu perfil profissional declarado.")); parent.Add(panel);
        }
        private void Profile(VisualElement parent)
        {
            parent.Add(ShellComponents.Text("Meu espaço", "hero-title"));
            var character = ShellComponents.Panel("Sua presença na jornada");
            character.Add(ShellComponents.Text("Escolha uma apresentação. Isso não define seu gênero, trabalho ou estado financeiro. A escolha vale somente para esta sessão.", "caption"));
            foreach (string id in new[] { "male", "female" })
            {
                string selected = id;
                character.Add(ShellComponents.Action(id == "male" ? "Apresentação masculina" : "Apresentação feminina", () => { navigation.SelectCharacter(selected); Redraw(); }, art?.Find(id)?.neutral != null, "quiet"));
            }
            character.Add(new CharacterPresentation(art, navigation.CharacterId, navigation.ReducedMotion)); parent.Add(character);
            var settings = ShellComponents.Panel("Conforto e privacidade");
            settings.Add(ShellComponents.Action(navigation.TextScale == 1 ? "Ampliar textos" : "Usar textos padrão", () => { navigation.ToggleTextScale(); Redraw(); }, true, "quiet"));
            settings.Add(ShellComponents.Text("A apresentação atual usa poses estáticas, sem animações.", "caption"));
            settings.Add(ShellComponents.Action("Atualizar dados", refresh));
            settings.Add(ShellComponents.Action("Sair", () => logout(false), true, "quiet"));
            settings.Add(ShellComponents.Action("Sair de todos os dispositivos", () => ShowSheet("Confirmar proteção", "Esta ação pode exigir uma nova autenticação. Deseja encerrar as sessões?", () => logout(true)), true, "quiet")); parent.Add(settings);
        }
        private void ShowCatalogue()
        {
            var overlay = new VisualElement(); overlay.AddToClassList("scrim");
            var surface = ShellComponents.Panel("Presenças para sua jornada"); surface.AddToClassList("sheet");
            var gallery = new ScrollView(); gallery.style.flexShrink = 1;
            gallery.Add(ShellComponents.Text("Catálogo visual. A escolha do seu personagem será feita depois de entrar."));
            foreach (string id in new[] { "male", "female" })
            {
                gallery.Add(ShellComponents.Text(id == "male" ? "Apresentação masculina" : "Apresentação feminina", "heading"));
                gallery.Add(new CharacterPresentation(art, id, true));
            }
            surface.Add(gallery); surface.Add(ShellComponents.Action("Voltar", () => overlay.RemoveFromHierarchy()));
            overlay.Add(surface); root.Add(overlay);
        }
        private void ShowSheet(string title, string detail, Action confirm = null)
        {
            VisualElement sheet = null;
            sheet = ShellComponents.Sheet(title, detail, () => sheet.RemoveFromHierarchy());
            if (confirm != null) sheet[0].Add(ShellComponents.Action("Confirmar", () => { sheet.RemoveFromHierarchy(); confirm(); }));
            root.Add(sheet);
        }
        private void Back(VisualElement parent, string title)
        { parent.Add(ShellComponents.Action("Voltar ao início", () => Go(ShellDestination.Home), true, "quiet")); parent.Add(ShellComponents.Text(title, "hero-title")); }
        private static void PageNotice(VisualElement parent, string next)
        { if (next != null) parent.Add(ShellComponents.Text("Exibindo a primeira página (até 100 itens). Há mais registros no servidor.", "caption")); }
        private void Nav()
        {
            var bar = new VisualElement(); bar.AddToClassList("navigation");
            var destinations = new[] { ShellDestination.Home, ShellDestination.Goals, ShellDestination.Reports, ShellDestination.Profile };
            var titles = new[] { "Início", "Metas", "Crônicas", "Meu espaço" };
            for (int i = 0; i < destinations.Length; i++)
            {
                var target = destinations[i]; var button = ShellComponents.Action(titles[i], () => Go(target), true, "nav-item");
                if (navigation.Destination == target || (target == ShellDestination.Home && (navigation.Destination == ShellDestination.Work || navigation.Destination == ShellDestination.Accounts))) button.AddToClassList("selected");
                bar.Add(button);
            }
            root.Add(bar);
        }
        private static string FailureMessage(Failure failure)
        {
            switch (failure)
            {
                case Failure.Offline: return "Você está sem conexão. Confira sua rede e tente novamente.";
                case Failure.Timeout: return "A conexão demorou mais que o esperado. Tente novamente.";
                case Failure.Unauthorized: return "Sua sessão terminou. Entre novamente para continuar.";
                case Failure.StepUp: return "Entre novamente para confirmar essa ação.";
                case Failure.Cancelled: return "A entrada foi cancelada.";
                case Failure.Protocol: return "Não foi possível carregar os dados com segurança.";
                default: return "O serviço está indisponível no momento. Tente novamente mais tarde.";
            }
        }
    }
}
