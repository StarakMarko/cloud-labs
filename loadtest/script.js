import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL;
const N = Number(__ENV.VUS || 30);

export const options = {
    stages: [
        { duration: '3m', target: N },
        { duration: '5m', target: N },
        { duration: '2m', target: 0 },
    ],
    thresholds: {
        http_req_failed: ['rate<0.05'],
        'http_req_duration{name:POST /parks}': ['p(95)<2000'],
    },
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function setup() {
    const creds = JSON.stringify({ email: 'loadtest@example.com', password: 'secret123' });
    http.post(`${BASE_URL}/auth/register`, creds, { headers: JSON_HEADERS });
    const res = http.post(`${BASE_URL}/auth/login`, creds, { headers: JSON_HEADERS });
    return { token: res.json('token') };
}

export default function (data) {
    const authHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${data.token}` };

    const body = JSON.stringify({
        name: `Park ${__VU}-${__ITER}`,
        address: 'Main St 1',
        length_of_bicycle_path: Math.round(Math.random() * 1000) / 100,
        price: Math.round(Math.random() * 100),
    });
    const created = http.post(`${BASE_URL}/parks`, body, {
        headers: authHeaders,
        tags: { name: 'POST /parks' },
    });
    check(created, { 'прийнято': (r) => r.status === 200 || r.status === 202 });

    let id = 1;
    if (created.status === 200) {
        id = created.json('id');
    } else if (created.status === 202) {
        const jobId = created.json('jobId');
        for (let i = 0; i < 10; i++) {
            sleep(0.5);
            const job = http.get(`${BASE_URL}/jobs/${jobId}`, { tags: { name: 'GET /jobs/:id' } });
            if (job.status === 200 && job.json('status') === 'done') {
                id = job.json('parkId');
                break;
            }
        }
    }

    for (let i = 0; i < 3; i++) {
        check(http.get(`${BASE_URL}/parks`, { tags: { name: 'GET /parks' } }),
            { 'список 200': (r) => r.status === 200 });
    }
    for (let i = 0; i < 3; i++) {
        check(http.get(`${BASE_URL}/parks/${id}`, { tags: { name: 'GET /parks/:id' } }),
            { 'за id 200': (r) => r.status === 200 });
    }
    for (let i = 0; i < 2; i++) {
        http.get(`${BASE_URL}/parks?search=Park`, { tags: { name: 'GET /parks?search' } });
    }
    http.get(`${BASE_URL}/parks?sortBy=price&sortDesc=true`, { tags: { name: 'GET /parks?sort' } });

    sleep(1);
}