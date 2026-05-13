// Plain-JS bootstrap that loads tsx's import hooks into this worker thread
// (workers don't inherit hooks from the parent), then dynamically imports the
// real worker entry. Keeping this in .mjs means it runs without any
// TypeScript transform — tsx itself takes over after register().
import { register } from 'tsx/esm/api';

register();
await import('./tournament-worker.ts');
