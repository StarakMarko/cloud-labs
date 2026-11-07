const mysql = require('mysql2/promise');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');

const requiredEnv = (name) => {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
    return process.env[name];
};

const QUEUE_URL = requiredEnv('QUEUE_URL');
const sqs = new SQSClient({ region: process.env.AWS_REGION || 'eu-central-1' });

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: requiredEnv('DB_PASSWORD'),
    database: process.env.DB_NAME || 'nodemysql',
    connectionLimit: 5
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function init() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS parks (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            address VARCHAR(255),
            length_of_bicycle_path DECIMAL(10,2),
            price DECIMAL(10,2)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS processed_jobs (
            job_id VARCHAR(36) PRIMARY KEY,
            park_id INT NOT NULL,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
}

async function handle(msg) {
    const { jobId, park } = JSON.parse(msg.Body);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [r] = await conn.query(
            "INSERT INTO parks (name, address, length_of_bicycle_path, price) VALUES (?, ?, ?, ?)",
            [park.name, park.address, park.length_of_bicycle_path, park.price]
        );
        await conn.query("INSERT INTO processed_jobs (job_id, park_id) VALUES (?, ?)", [jobId, r.insertId]);
        await conn.commit();
        console.log(`job ${jobId} done, park ${r.insertId}`);
    } catch (e) {
        await conn.rollback();
        if (e.code === 'ER_DUP_ENTRY') {
            console.log(`job ${jobId} already processed, skipping`);
        } else {
            throw e;
        }
    } finally {
        conn.release();
    }
}

let running = true;
process.on('SIGTERM', () => { running = false; });

async function main() {
    await init();
    console.log('worker started');
    while (running) {
        try {
            const res = await sqs.send(new ReceiveMessageCommand({
                QueueUrl: QUEUE_URL,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 20
            }));
            for (const msg of res.Messages || []) {
                try {
                    await handle(msg);
                    await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: msg.ReceiptHandle }));
                } catch (e) {
                    console.error('job failed, will be redelivered:', e.message);
                }
            }
        } catch (e) {
            console.error('receive error:', e.message);
            await sleep(5000);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });