# BuildSight

Hands-free build copilot (Cal Hacks 13.0). Show it any picture-based instructions; it watches you build through the camera, tells you what's next, and catches mistakes.

All decisions so far: [DECISIONS.md](DECISIONS.md). A full README comes before submission.

## Run it

```bash
npm install
cp .env.example .env.local   # then paste your OpenRouter key into .env.local
npm run dev                  # http://localhost:3000
```

The camera needs HTTPS on phones; use the Vercel deployment link there. `localhost` works on a laptop.
