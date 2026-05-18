
import Database from 'better-sqlite3';
import { initializeSchema, runMigrations } from './src/core/migrations.js';
import { extractHighlightsForSession } from './src/angel/highlights-extractor.js';
export { Database, initializeSchema, runMigrations, extractHighlightsForSession };
