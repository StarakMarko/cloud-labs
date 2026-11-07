const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const YAML = require('yaml');
const swaggerUi = require('swagger-ui-express');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();

const requiredEnv = (name) => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
};

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = requiredEnv('JWT_SECRET');

const { createClient } = require('redis');

const CACHE_ENABLED = process.env.CACHE_ENABLED === 'true';
const CACHE_TTL = Number(process.env.CACHE_TTL || 30);

let redis = null;
if (process.env.REDIS_HOST) {
    redis = createClient({ url: `redis://${process.env.REDIS_HOST}:6379` });
    redis.on('error', e => console.error('redis error', e.message));
    redis.connect().catch(e => console.error('redis connect failed', e.message));
}
const cacheReady = () => redis && redis.isReady;
const cacheOn = () => CACHE_ENABLED && cacheReady();

const crypto = require('node:crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const QUEUE_URL = process.env.QUEUE_URL;
const sqs = QUEUE_URL ? new SQSClient({ region: process.env.AWS_REGION || 'eu-central-1' }) : null;

app.use(cors());
app.use(express.json());

const openapiDoc = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDoc));
app.get('/openapi.json', (req, res) => res.json(openapiDoc));

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: requiredEnv('DB_PASSWORD'),
    database: process.env.DB_NAME || 'nodemysql'
});

const auth = (req, res, next) => {
    const [type, token] = (req.headers.authorization || '').split(' ');
    if (type !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Missing token' });
    }
    try {
        req.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

const idempotent = async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (!cacheReady()) {
        return res.status(503).json({ error: 'Idempotency store unavailable' });
    }

    const redisKey = `idem:${req.user.sub}:${key}`;
    const claimed = await redis.set(redisKey, JSON.stringify({ state: 'processing' }), { NX: true, EX: 86400 });

    if (!claimed) {
        const stored = JSON.parse((await redis.get(redisKey)) || '{}');
        if (stored.state === 'done') {
            res.set('Idempotent-Replayed', 'true');
            return res.status(stored.status).json(stored.body);
        }
        return res.status(409).json({ error: 'Request with this key is still in progress' });
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        const save = res.statusCode < 500
            ? redis.set(redisKey, JSON.stringify({ state: 'done', status: res.statusCode, body }), { EX: 86400 })
            : redis.del(redisKey);
        save.catch(() => { }).finally(() => originalJson(body));
        return res;
    };
    next();
};

db.connect(err => {
    if (err) {
        console.error('error', err);
        return;
    }
    console.log('ok');

    db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL
        )
    `, e => { if (e) console.error('users table error', e); });

    db.query(`
        CREATE TABLE IF NOT EXISTS parks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            address VARCHAR(255),
            length_of_bicycle_path DECIMAL(10,2),
            price DECIMAL(10,2)
        )
    `, e => { if (e) console.error('parks table error', e); });

    db.query(`
    CREATE TABLE IF NOT EXISTS processed_jobs (
        job_id VARCHAR(36) PRIMARY KEY,
        park_id INT NOT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`, e => { if (e) console.error('processed_jobs table error', e); });
});


app.get('/', (req, res) => {
    res.send('ok');
});

app.post('/auth/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'email and password required' });
    }
    const hash = await bcrypt.hash(password, 10);
    db.query("INSERT INTO users (email, password_hash) VALUES (?, ?)", [email, hash], (err, data) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'User exists' });
            return res.status(500).json({ error: 'DB error' });
        }
        return res.status(201).json({ id: data.insertId });
    });
});

app.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    db.query("SELECT * FROM users WHERE email = ?", [email], async (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
            algorithm: 'HS256',
            expiresIn: '1h'
        });
        return res.json({ token });
    });
});

app.get('/parks', async (req, res) => {
    const { search = '', sortBy = '', sortDesc = 'false' } = req.query;

    let q = "SELECT * FROM parks";
    const values = [];
    if (search) {
        q += " WHERE name LIKE ?";
        values.push(`%${search}%`);
    }
    if (sortBy && ['price', 'length_of_bicycle_path', 'name'].includes(sortBy)) {
        q += ` ORDER BY ${sortBy} ${sortDesc === 'true' ? 'DESC' : 'ASC'}`;
    }

    const key = `parks:${search}:${sortBy}:${sortDesc}`;

    if (cacheReady()) {
        try {
            const cached = await redis.get(key);
            if (cached) {
                redis.incr('stats:hits').catch(() => { });
                res.set('X-Cache', 'HIT');
                return res.json(JSON.parse(cached));
            }
            redis.incr('stats:misses').catch(() => { });
        } catch (e) {
            console.error('cache read error', e.message);
        }
    }

    db.query(q, values, (err, data) => {
        if (err) return res.status(500).json({ error: 'DB error' });

        const totalLength = data.reduce((sum, p) => sum + parseFloat(p.length_of_bicycle_path || 0), 0);
        const payload = { parks: data, totalLength };

        if (cacheReady()) {
            redis.set(key, JSON.stringify(payload), { EX: CACHE_TTL }).catch(() => { });
        }
        res.set('X-Cache', 'MISS');
        return res.json(payload);
    });
});

app.get('/parks/:id', (req, res) => {
    const parkId = Number(req.params.id);
    if (!Number.isInteger(parkId)) {
        return res.status(400).json({ error: 'Invalid id' });
    }

    db.query("SELECT * FROM parks WHERE id = ?", [parkId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        if (rows.length === 0) return res.status(404).json({ error: 'Park not found' });
        return res.json(rows[0]);
    });
});

app.post('/parks', auth, idempotent, async (req, res) => {
    const { name, address, length_of_bicycle_path, price } = req.body;

    if (sqs) {
        const jobId = crypto.randomUUID();
        try {
            await sqs.send(new SendMessageCommand({
                QueueUrl: QUEUE_URL,
                MessageBody: JSON.stringify({
                    jobId,
                    park: { name, address, length_of_bicycle_path, price }
                })
            }));
        } catch (e) {
            console.error('sqs send failed', e.message);
            return res.status(503).json({ error: 'Queue unavailable' });
        }
        res.set('Location', `/jobs/${jobId}`);
        return res.status(202).json({ jobId, status: 'pending', statusUrl: `/jobs/${jobId}` });
    }

    const q = "INSERT INTO parks (`name`, `address`, `length_of_bicycle_path`, `price`) VALUES (?, ?, ?, ?)";
    db.query(q, [name, address, length_of_bicycle_path, price], (err, data) => {
        if (err) return res.status(500).json(err);
        return res.json({ message: "add new park", id: data.insertId });
    });
});

app.put('/parks/:id', auth, (req, res) => {
    const parkId = req.params.id;
    const { name, address, length_of_bicycle_path, price } = req.body;

    const q = `
        UPDATE parks 
        SET name = ?, address = ?, length_of_bicycle_path = ?, price = ? 
        WHERE id = ?
    `;
    const values = [name, address, length_of_bicycle_path, price, parkId];

    db.query(q, values, (err, data) => {
        if (err) return res.status(500).json(err);
        return res.json({ message: "park eddited" });
    });
});

app.delete('/parks/:id', auth, (req, res) => {
    const parkId = req.params.id;
    const q = "DELETE FROM parks WHERE id = ?";
    db.query(q, [parkId], (err, data) => {
        if (err) return res.status(500).json(err);
        return res.json({ message: "park deleted" });
    });
});

app.get('/cache/stats', async (req, res) => {
    if (!cacheReady()) return res.json({ enabled: false });
    const hits = Number(await redis.get('stats:hits') || 0);
    const misses = Number(await redis.get('stats:misses') || 0);
    const total = hits + misses;
    res.json({ enabled: true, hits, misses, hitRatio: total ? hits / total : 0 });
});

app.get('/jobs/:id', (req, res) => {
    db.query("SELECT park_id FROM processed_jobs WHERE job_id = ?", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        if (rows.length === 0) return res.json({ jobId: req.params.id, status: 'pending' });
        return res.json({ jobId: req.params.id, status: 'done', parkId: rows[0].park_id });
    });
});

const server = app.listen(8000, () => console.log('Server is running on 8000'));
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server');
    server.close(() => db.end(() => process.exit(0)));
});
