# Cloud Labs

REST API для керування парками (Node.js + Express + MySQL), запакований у Docker і розгорнутий в AWS через Terraform з автоматичним деплоєм із GitHub Actions.

**Публічна адреса:** [http://lab1-alb-2027386291.eu-central-1.elb.amazonaws.com/](http://lab1-alb-2027386291.eu-central-1.elb.amazonaws.com/)

**Документація API (Swagger UI):** [http://lab1-alb-2027386291.eu-central-1.elb.amazonaws.com/docs](http://lab1-alb-2027386291.eu-central-1.elb.amazonaws.com/docs)

---

## Лабораторна робота 2: Автоматичне масштабування, моніторинг та кешування


## Структура проєкту

```text
lab1/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── app/
│   ├── node_modules/
│   ├── .dockerignore
│   ├── .env
│   ├── compose.yaml
│   ├── Dockerfile
│   ├── init.sql
│   ├── openapi.yaml
│   ├── package-lock.json
│   ├── package.json
│   ├── server.js
├── terraform/
│   ├── .terraform/
│   ├── .terraform.lock.hcl
│   ├── alb.tf
│   ├── budget.tf
│   ├── ecr.tf
│   ├── ecs.tf
│   ├── github_oidc.tf
│   ├── monitoring.tf
│   ├── network.tf
│   ├── provider.tf
│   ├── rds.tf
│   ├── terraform.tfstate
│   ├── terraform.tfstate.backup
│   ├── terraform.tfvars
│   └── variables.tf
├── .gitignore
└── README.md
```
