// Writes the envelope as JSON Schema, the language-neutral copy for sources outside TypeScript.
// Run `npm run contract:schema` after changing the envelope; the tests fail while it is stale.

import { mkdirSync, writeFileSync } from 'node:fs';
import { schemaFile, schemaText } from './schema.ts';

mkdirSync(new URL('.', schemaFile), { recursive: true });
writeFileSync(schemaFile, schemaText());
console.log(`wrote ${schemaFile.pathname}`);
