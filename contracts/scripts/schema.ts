import * as z from 'zod';
import { CONTRACT_VERSION, MiraEvent } from '../src/envelope.ts';

export const schemaFile = new URL('../schema/mira-event.schema.json', import.meta.url);

export function schemaText(): string {
  const schema = { title: `Mira event (contract v${CONTRACT_VERSION})`, ...z.toJSONSchema(MiraEvent) };
  return `${JSON.stringify(schema, null, 2)}\n`;
}
