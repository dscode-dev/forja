// Technical date/cursor index: verifies a contribution bucket without scanning/decrypting history.
exports.up = pgm => pgm.sql(`CREATE INDEX finance_utc_day_cursor ON app.finance_events(user_id,account_id,(left(effective_at,10)),seq DESC);`);
exports.down = pgm => pgm.sql(`DROP INDEX app.finance_utc_day_cursor;`);
