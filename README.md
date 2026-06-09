# MoovOPS — Documentation Technique (Partie Développeur)

## Présentation

MoovOPS est un pipeline ETL (Extract, Transform, Load) qui collecte en continu les données de disponibilité des vélos Vélib' et les corrèle avec la météo en temps réel à Paris. Les données sont stockées dans une base MySQL sous deux formes : brute (JSON d'origine) et structurée (tables relationnelles).

---

## Architecture du projet

```
moovops_Full/
├── pipeline.js          # Script ETL principal
├── pipeline.test.js     # Suite de tests Jest (Palier 3)
├── init.sql             # Schéma de base de données
├── package.json         # Dépendances Node.js
├── .env                 # Variables d'environnement (non versionné)
├── docker-compose.yml   # Infrastructure Docker
└── .github/
    └── workflows/
        └── ci.yml       # Pipeline CI GitHub Actions
```

---

## Sources de données

| API | URL | Données récupérées |
|-----|-----|--------------------|
| CityBikes (Vélib') | `http://api.citybik.es/v2/networks/velib` | Stations, coordonnées, vélos disponibles |
| Open-Meteo | `https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current_weather=true` | Température actuelle à Paris |

---

## Schéma de base de données

Le pipeline utilise deux bases de données distinctes.

### `moovops_raw` — Zone brute

```sql
CREATE TABLE moovops_raw (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    json_payload TEXT     NOT NULL,           -- JSON brut de la station
    import_date  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Chaque appel à l'API insère une ligne par station, sans transformation. Cette table conserve l'intégralité de la donnée d'origine.

### `moovops_clean` — Zone structurée

**Table `stations`** — données statiques, une ligne par station physique :

```sql
CREATE TABLE stations (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255) UNIQUE NOT NULL,  -- contrainte UNIQUE → idempotence
    latitude   DECIMAL(10, 7) NOT NULL,
    longitude  DECIMAL(10, 7) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Table `historique_dispo`** — données dynamiques, une ligne par collecte :

```sql
CREATE TABLE historique_dispo (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    id_station           INT NOT NULL,
    velos_dispo          INT NOT NULL,
    temperature_actuelle DECIMAL(5, 2),
    date                 DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_station) REFERENCES stations(id)
);
```

La clé étrangère `id_station` lie chaque snapshot de disponibilité à la station correspondante.

---

## Pipeline ETL — Fonctionnement détaillé

### Vue d'ensemble

```
APIs externes          pipeline.js           MySQL
─────────────    ──────────────────────    ─────────────────────────
CityBikes    ──►                          moovops_raw.moovops_raw
                  Promise.all()    ──►    moovops_clean.stations
Open-Meteo   ──►  (simultané)     ──►    moovops_clean.historique_dispo
```

### Étapes d'exécution

**Étape 0 — Connexion MySQL**

Le script ouvre une connexion MySQL via les variables d'environnement du fichier `.env`. Si la connexion échoue, l'erreur est capturée par le bloc `try/catch` principal et la connexion est fermée proprement dans le `finally`.

**Étape 1 — Extract : appel simultané des deux APIs**

```js
const [bikesResponse, meteoResponse] = await Promise.all([
    axios.get(CITYBIKES_URL),
    axios.get(METEO_URL)
]);
```

`Promise.all()` lance les deux requêtes HTTP en parallèle. Le pipeline attend que les deux soient terminées avant de continuer, ce qui minimise le temps d'attente.

**Étape 2 — Validation**

Avant toute insertion, deux validations sont effectuées :

- **Température** : si la valeur retournée par l'API est hors de la plage [-20°C, +50°C], le pipeline lève une erreur et abandonne la collecte pour ce cycle.
- **Coordonnées** (par station) : toute station dont la latitude ou la longitude est `null` ou égale à `0` est ignorée avec un avertissement (`console.warn`).

**Étape 3 — Load : insertion en base**

Pour chaque station valide, le script effectue dans l'ordre :

1. `INSERT` dans `moovops_raw` — JSON brut de la station.
2. `INSERT IGNORE` dans `moovops_clean.stations` — crée la station si elle n'existe pas encore, sinon ne fait rien (idempotence garantie par la contrainte `UNIQUE` sur `name`).
3. `SELECT id` pour récupérer l'identifiant de la station (qu'elle vienne d'être créée ou qu'elle existait déjà).
4. `INSERT` dans `moovops_clean.historique_dispo` — enregistre la disponibilité actuelle avec la température.

Chaque station est traitée dans son propre `try/catch` : une erreur sur une station n'interrompt pas le traitement des suivantes.

### Exécution en boucle

```js
runPipeline();                                    // exécution immédiate au démarrage
cron.schedule('*/10 * * * *', runPipeline);       // puis toutes les 10 minutes
```

Le script ne s'arrête jamais. La bibliothèque `node-cron` planifie une exécution toutes les 10 minutes.

---

## Installation et lancement

### Prérequis

- [Node.js](https://nodejs.org/) v18+
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

### 1. Démarrer l'infrastructure Docker

```bash
docker compose up -d
```

Cette commande lance MySQL (port 3307) et crée automatiquement le schéma via `init.sql`.

### 2. Configurer les variables d'environnement

Créer un fichier `.env` à la racine (ou vérifier qu'il existe) :

```env
DB_HOST=localhost
DB_PORT=3307
DB_USER=root
DB_PASSWORD=pass
```

### 3. Installer les dépendances Node.js

```bash
npm install
```

### 4. Lancer le pipeline

```bash
npm start
```

Le script s'exécute immédiatement, puis toutes les 10 minutes en autonomie.

---

## Tests (Palier 3 — Zéro Défaut)

Les tests sont écrits avec le framework **Jest** et se connectent à la base de données réelle. Ils doivent donc être lancés avec Docker en fonctionnement.

```bash
npm test
```

### Test 1 — Coordonnées valides

```
Aucune station ne possède de coordonnées vides (latitude ou longitude NULL / zéro)
```

Requête SQL exécutée sur `moovops_clean.stations`. Vérifie que le filtre du pipeline a bien écarté toutes les stations sans position géographique valide.

### Test 2 — Température cohérente

```
Toutes les températures historiques sont dans la plage [-20°C, +50°C]
```

Requête SQL exécutée sur `moovops_clean.historique_dispo`. Vérifie que la validation effectuée avant insertion a bien bloqué toute valeur aberrante.

### Test 3 — Idempotence

```
L'idempotence est garantie : deux insertions identiques ne produisent qu'une seule ligne
```

Insère deux fois la même station de test dans `moovops_clean.stations` via `INSERT IGNORE`, puis vérifie qu'il n'existe qu'une seule ligne pour ce nom. La ligne de test est supprimée à la fin (`DELETE`) pour ne pas polluer la base.

---

## Dépendances

| Package | Version | Rôle |
|---------|---------|------|
| `axios` | ^1.16 | Requêtes HTTP vers les APIs |
| `mysql2` | ^3.22 | Pilote MySQL avec support des promesses |
| `node-cron` | ^3.0 | Planification des exécutions toutes les 10 min |
| `dotenv` | ^17.4 | Chargement des variables d'environnement |
| `jest` | ^30.4 | Framework de tests (dépendance de développement) |

---

## Gestion des erreurs

Le pipeline applique une stratégie de défense en profondeur à trois niveaux :

| Niveau | Portée | Comportement en cas d'erreur |
|--------|--------|------------------------------|
| `try/catch` global | Connexion SQL, appels API, validation | Log `CRASH FATAL`, fermeture propre de la connexion |
| `try/catch` par station | Traitement d'une station individuelle | Log de l'erreur, passage à la station suivante |
| `try/catch` dans `finally` | Fermeture de la connexion | Log si la fermeture elle-même échoue |
