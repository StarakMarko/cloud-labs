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

app.get('/parks', (req, res) => {
    let { search = '', sortBy = '', sortDesc = 'false' } = req.query;

    let q = "SELECT * FROM parks";
    const values = [];

    if (search) {
        q += " WHERE name LIKE ?";
        values.push(`%${search}%`);
    }

    if (sortBy) {
        const order = sortDesc === 'true' ? 'DESC' : 'ASC';
        if (['price', 'length_of_bicycle_path', 'name'].includes(sortBy)) {
            q += ` ORDER BY ${sortBy} ${order}`;
        }
    }

    db.query(q, values, (err, data) => {
        if (err) return res.status(500).json(err);

        const totalLength = data.reduce((sum, park) => sum + parseFloat(park.length_of_bicycle_path || 0), 0);

        return res.json({ parks: data, totalLength });
    });
});


app.post('/parks', auth, (req, res) => {
    const { name, address, length_of_bicycle_path, price } = req.body;
    const q = "INSERT INTO parks (`name`, `address`, `length_of_bicycle_path`, `price`) VALUES (?, ?, ?, ?)";
    const values = [name, address, length_of_bicycle_path, price];

    db.query(q, values, (err, data) => {
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

app.listen(8000, () => console.log(`Server is running on 8000`));
