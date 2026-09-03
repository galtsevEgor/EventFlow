console.log(`EventFlow development commands

pnpm env:init          Generate local credentials; preserve an existing .env
pnpm infra:up          Start local dependencies and wait for health checks
pnpm infra:down        Stop dependencies; preserve project data volumes
pnpm infra:status      Show dependency status
pnpm identity:seed     Configure local Keycloak and demo accounts
pnpm db:migrate        Apply Catalog migrations
pnpm dev               Start applications behind the shared local origin
pnpm check             Repository policy, boundaries, format, lint, types and unit tests
pnpm build             Build every workspace
pnpm test:smoke        Launch and check all seven built applications
pnpm test:infra        Test actual local dependencies and database isolation
pnpm test:catalog      Test organization and authorization rules in isolated databases
pnpm test:identity     Test real Keycloak login, sessions, CSRF and token validation
pnpm test:e2e          Run the full browser journey against built applications
pnpm browser:install   Install the Chromium browser used by identity and E2E tests
pnpm storybook         Open UI component development server on port 6006
pnpm storybook:build   Build the UI component gallery
pnpm test:spikes       Check Prisma concurrency and fake payment cancellation
pnpm tools:setup       Install checksum-pinned local quality tools
pnpm check:workflow    Validate GitHub Actions syntax
pnpm check:secrets     Scan Git history and tracked working files
pnpm audit:runtime     Audit production dependencies; reject high/critical findings
pnpm ci:local          Run the complete E1 gate (Docker required)

Runtime: Node.js 24.22.1, pnpm 10.34.9
Storefront: http://127.0.0.1:18000
Organizer: http://127.0.0.1:18000/organizer/
Local demo credentials: work/local/demo-users.json (never committed)
Backend health: http://127.0.0.1:4000/health/ready (services: 4001–4004)
`);
