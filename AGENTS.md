# Repository Guidelines

## Project Structure & Module Organization
- `src/app/` uses the Next.js App Router. `layout.tsx` wires fonts/theme, `page.tsx` renders the landing UI, and `globals.css` sets Tailwind v4 inline theme tokens.  
- `public/` holds static assets (favicons, logos); any files here are served at site root.  
- Root configs: `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, and `package.json` for scripts/deps. Runtime env values live in `.env` (not committed).  
- Add new routes/components under `src/app/<route>/page.tsx`; co-locate supporting components in `src/app/<route>/components/` when they are route-specific.

## Build, Test, and Development Commands
- `npm run dev` — Start the dev server on http://localhost:3000 with hot reload.  
- `npm run lint` — ESLint with `next` rules; fix warnings before pushing.  
- `npm run build` — Production build; fails on type or lint errors.  
- `npm run start` — Serve the built app (requires prior `npm run build`).  
If you add tests, expose them via `npm test` (see Testing Guidelines below) to keep the script surface consistent.

## Coding Style & Naming Conventions
- Language: TypeScript + React 19 functional components; prefer server components unless client-only APIs are needed.  
- Styling: Tailwind utility classes in JSX; place global tokens in `globals.css`. Keep class lists ordered by layout → spacing → typography → color for readability.  
- Files: use kebab-case for routes (`src/app/video-notes/page.tsx`), PascalCase for components, and camelCase for variables/functions.  
- Imports: absolute paths not configured—use relative paths and group Node/3rd-party/local in that order.  
- Run `npm run lint` before commit; align with suggested fixes instead of disabling rules.

## Testing Guidelines
- No test runner is configured yet; recommended setup is Jest + React Testing Library under `src/__tests__/` with file names like `ComponentName.test.tsx`.  
- Aim for component-level tests that cover rendering and critical interactions; add mock data instead of hitting live endpoints.  
- When introducing tests, add a coverage threshold in Jest config (e.g., 70% lines) to prevent regressions.

## Commit & Pull Request Guidelines
- Current history is minimal (`Initial commit from Create Next App`); keep messages in present tense, 50 chars or fewer (e.g., `Add video upload card`).  
- Scope one logical change per commit; include brief body only when context is non-obvious.  
- PRs should describe the change, link related issues, list manual test steps, and attach UI screenshots/GIFs for visual updates.  
- Ensure `npm run lint` (and `npm test` once added) pass before requesting review.

## Environment & Configuration Tips
- Keep secrets out of git. For values needed in the browser, use `NEXT_PUBLIC_*` keys; server-only values omit the prefix.  
- When adding new env keys, document them in `.env.example` and mention required formats or defaults in the PR description.
