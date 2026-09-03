console.log(`EventFlow development commands

pnpm env:init          Generate local credentials; preserve an existing .env
pnpm infra:up          Start local dependencies and wait for health checks
pnpm infra:down        Stop dependencies; preserve project data volumes
pnpm infra:status      Show dependency status
pnpm dev               Start the two frontends and five backend processes
pnpm check             Repository policy, boundaries, format, lint, types and unit tests
pnpm build             Build every workspace
pnpm test:smoke        Launch and check all seven built applications
pnpm test:infra        Test actual local dependencies and database isolation
pnpm test:spikes       Check Prisma concurrency and fake payment cancellation
pnpm tools:setup       Install checksum-pinned local quality tools
pnpm check:workflow    Validate GitHub Actions syntax
pnpm check:secrets     Scan Git history and tracked working files
pnpm audit:runtime     Audit production dependencies; reject high/critical findings
pnpm ci:local          Run the complete E0 gate (Docker required)

Runtime: Node.js 24.22.1, pnpm 10.34.9
Storefront: http://localhost:3000
Organizer: http://localhost:3001/organizer/
Backend health: http://127.0.0.1:4000/health/ready (services: 4001–4004)
`);
