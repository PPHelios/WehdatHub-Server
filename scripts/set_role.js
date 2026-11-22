const { getPool } = require('../lib/db');
const role = process.argv[2] || 'manager';

(async () => {
  try {
    const pool = getPool();
    await pool.query("UPDATE brokers SET role = $1 WHERE phone_normalized = '201012345674'", [role]);
    const res = await pool.query("SELECT id, name, role, agency_id FROM brokers WHERE phone_normalized = '201012345674'");
    console.log("Updated role to:", res.rows[0].role);
    await pool.end();
  } catch (e) {
    console.error(e);
  }
})();
