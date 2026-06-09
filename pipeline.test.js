require('dotenv').config();
const mysql = require('mysql2/promise');

// Timeout élevé car on interroge une vraie base MySQL
jest.setTimeout(15000);

describe('MoovOPS Pipeline', () => {
  let connection;

  beforeAll(async () => {
    connection = await mysql.createConnection({
      host:     process.env.DB_HOST,
      port:     process.env.DB_PORT,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
  });

  afterAll(async () => {
    if (connection) await connection.end();
  });

  // -----------------------------------------------------------------------
  // Test 1 : Aucune station ne doit avoir des coordonnées vides ou nulles
  // -----------------------------------------------------------------------
  test('Aucune station ne possède de coordonnées vides (latitude ou longitude NULL / zéro)', async () => {
    const [[{ count }]] = await connection.execute(`
      SELECT COUNT(*) AS count
      FROM moovops_clean.stations
      WHERE latitude  IS NULL OR longitude IS NULL
         OR latitude  = 0    OR longitude  = 0
    `);
    expect(Number(count)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 2 : Chaque température enregistrée doit être entre -20°C et +50°C
  // -----------------------------------------------------------------------
  test('Toutes les températures historiques sont dans la plage [-20°C, +50°C]', async () => {
    const [[{ count }]] = await connection.execute(`
      SELECT COUNT(*) AS count
      FROM moovops_clean.historique_dispo
      WHERE temperature_actuelle < -20
         OR temperature_actuelle > 50
    `);
    expect(Number(count)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 3 : Idempotence — INSERT IGNORE ne crée pas de doublons
  //          Insérer deux fois la même station → une seule ligne en base
  // -----------------------------------------------------------------------
  test("L'idempotence est garantie : deux insertions identiques ne produisent qu'une seule ligne", async () => {
    const nomTest = `__IDEMPOTENCE_TEST_${Date.now()}`;

    // Première insertion
    await connection.execute(
      `INSERT IGNORE INTO moovops_clean.stations (name, latitude, longitude) VALUES (?, ?, ?)`,
      [nomTest, 48.8566, 2.3522]
    );

    // Deuxième insertion identique — doit être silencieusement ignorée
    await connection.execute(
      `INSERT IGNORE INTO moovops_clean.stations (name, latitude, longitude) VALUES (?, ?, ?)`,
      [nomTest, 48.8566, 2.3522]
    );

    const [[{ count }]] = await connection.execute(
      `SELECT COUNT(*) AS count FROM moovops_clean.stations WHERE name = ?`,
      [nomTest]
    );

    // Nettoyage de la ligne de test
    await connection.execute(
      `DELETE FROM moovops_clean.stations WHERE name = ?`,
      [nomTest]
    );

    expect(Number(count)).toBe(1);
  });
});
