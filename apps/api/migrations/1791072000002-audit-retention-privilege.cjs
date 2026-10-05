exports.up = pgm => pgm.sql('GRANT SELECT(created_at) ON app.security_events TO forja_app;');
exports.down = pgm => pgm.sql('REVOKE SELECT(created_at) ON app.security_events FROM forja_app;');
