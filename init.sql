-- Zone brute : stockage du JSON tel quel depuis l'API
CREATE DATABASE IF NOT EXISTS moovops_raw;

-- Zone propre : données nettoyées et structurées
CREATE DATABASE IF NOT EXISTS moovops_clean;

-- Table brute : un snapshot JSON par station par collecte
USE moovops_raw;
CREATE TABLE IF NOT EXISTS moovops_raw (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    json_payload TEXT NOT NULL,
    import_date  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Palier 2 : deux tables relationnelles dans moovops_clean
USE moovops_clean;

-- Données statiques : une ligne par station (idempotence via UNIQUE sur name)
CREATE TABLE IF NOT EXISTS stations (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255) UNIQUE NOT NULL,
    latitude   DECIMAL(10, 7) NOT NULL,
    longitude  DECIMAL(10, 7) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Données dynamiques : une ligne par collecte — l'historique complet
CREATE TABLE IF NOT EXISTS historique_dispo (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    id_station           INT NOT NULL,
    velos_dispo          INT NOT NULL,
    temperature_actuelle DECIMAL(5, 2),
    date                 DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_station) REFERENCES stations(id)
);
