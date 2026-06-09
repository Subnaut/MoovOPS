require('dotenv').config();
const mysql = require('mysql2/promise');
const axios = require('axios');
const cron = require('node-cron');

const CITYBIKES_URL = 'http://api.citybik.es/v2/networks/velib';
const METEO_URL = 'https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current_weather=true';

async function runPipeline() {
    console.log(`\n[${new Date().toISOString()}] Démarrage du pipeline ETL MoovOPS...`);
    let connection;

    try {
        // --- Étape 0 : Connexion MySQL ---
        connection = await mysql.createConnection({
            host:     process.env.DB_HOST,
            port:     process.env.DB_PORT,
            user:     process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        console.log('Connexion au serveur SQL réussie.');

        // --- Étape 1 : Extract & Transform
        console.log('Appel simultané des APIs CityBikes et Open-Meteo...');
        const [bikesResponse, meteoResponse] = await Promise.all([
            axios.get(CITYBIKES_URL),
            axios.get(METEO_URL)
        ]);

        const stations    = bikesResponse.data.network.stations;
        const temperature = meteoResponse.data.current_weather.temperature;
        console.log(`${stations.length} stations extraites. Température actuelle : ${temperature}°C`);

        // --- Étape 2 : Load ---
        let rawInserees       = 0;
        let stationsCreees    = 0;
        let historiqueInserees = 0;

        // Validation de la température avant toute insertion
        if (temperature < -20 || temperature > 50) {
            throw new Error(`Température hors plage : ${temperature}°C (attendu : -20 à +50°C)`);
        }

        for (const station of stations) {
            try {
                // Validation des coordonnées — on ignore les stations sans position valide
                if (!station.latitude || !station.longitude ||
                    station.latitude === 0 || station.longitude === 0) {
                    console.warn(`Station ignorée (coordonnées invalides) : "${station.name}"`);
                    continue;
                }

                // ---- ZONE RAW : JSON brut de chaque station ----
                const [resultRaw] = await connection.execute(
                    `INSERT INTO moovops_raw.moovops_raw (json_payload) VALUES (?)`,
                    [JSON.stringify(station)]
                );
                if (resultRaw.affectedRows > 0) rawInserees++;

                // ---- ZONE CLEAN — table stations ----
                const [resultStation] = await connection.execute(
                    `INSERT IGNORE INTO moovops_clean.stations (name, latitude, longitude) VALUES (?, ?, ?)`,
                    [station.name, station.latitude, station.longitude]
                );
                if (resultStation.affectedRows > 0) stationsCreees++;

                // Récupération de l'id
                const [[row]] = await connection.execute(
                    `SELECT id FROM moovops_clean.stations WHERE name = ?`,
                    [station.name]
                );

                // ---- ZONE CLEAN — table historique_dispo ----
                const [resultHisto] = await connection.execute(
                    `INSERT INTO moovops_clean.historique_dispo (id_station, velos_dispo, temperature_actuelle)
                     VALUES (?, ?, ?)`,
                    [row.id, station.free_bikes, temperature]
                );
                if (resultHisto.affectedRows > 0) historiqueInserees++;

            } catch (stationError) {
                console.error(`Erreur sur la station "${station.name}":`, stationError.message);
            }
        }

        console.log('Pipeline terminé avec succès !');
        console.log(`  - ${rawInserees} enregistrements bruts insérés`);
        console.log(`  - ${stationsCreees} nouvelles stations créées`);
        console.log(`  - ${historiqueInserees} snapshots historiques insérés`);

    } catch (error) {
        console.error('CRASH FATAL DU PIPELINE :', error.message);
    } finally {
        if (connection) {
            try {
                await connection.end();
                console.log('Connexion SQL fermée proprement.');
            } catch (closeError) {
                console.error('Impossible de fermer la connexion SQL :', closeError.message);
            }
        }
    }
}

// Lancement immédiat au démarrage, puis toutes les 10 minutes
try {
    runPipeline();
    cron.schedule('*/10 * * * *', runPipeline);
    console.log('Pipeline planifié : prochaine exécution automatique dans 10 minutes.');
} catch (startError) {
    console.error('Erreur au démarrage du pipeline :', startError.message);
    process.exit(1);
}
