// Unified MCP action parameters and response types.
import type { z as ZodType } from 'zod';
const ACTIONS = [
  'assemble',
  'search',
  'index',
  'status',
  'files',
  'backup',
  'restore',
  'gc',
  'embed',
  'health',
] as const;

/** MCP tool response shape (index signature required by MCP SDK) */
export interface ToolResponse {
  [x: string]: unknown;
  content: Array<{ [x: string]: unknown; type: 'text'; text: string }>;
  isError?: boolean;
}

/** Build the unified tool schema */
export function buildToolSchema(z: typeof ZodType): Record<string, unknown> {
  return {
    action: z
      .enum(ACTIONS)
      .describe('Action to execute (assemble: auto AI context assembly ★core)'),
    query: z.string().max(4096).optional().describe('Search query (required for search action)'),
    topK: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Number of search results (default: 10)'),
    language: z.string().optional().describe('Language filter (js, ts, py, rs, ...)'),
    path: z.string().optional().describe('Indexing target path (default: project root)'),
    force: z.boolean().optional().describe('If true, force full re-indexing'),
    label: z.string().optional().describe('Backup label (human-readable name)'),
    backupId: z.string().optional().describe('Backup ID (defaults to latest)'),
    searchBackups: z.boolean().optional().describe('If true, also search backup DBs'),
    maxAge: z
      .number()
      .int()
      .min(0)
      .max(36500)
      .optional()
      .describe('Delete backups older than N days'),
    maxCount: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe('Maximum number of backups to keep'),
    pattern: z.string().max(512).optional().describe('File filter Git-style pattern'),
    offset: z.number().int().min(0).max(100000).optional().describe('File page offset'),
    limit: z.number().int().min(1).max(1000).optional().describe('Files per page, defaults to 200'),
    ...buildAssemblySchema(z),
  };
}

function buildAssemblySchema(z: typeof ZodType): Record<string, unknown> {
  return {
    activeFile: z.string().optional().describe('Current active file path (used in assemble)'),
    budget: z
      .number()
      .int()
      .min(0)
      .max(1000000)
      .optional()
      .describe('Token budget (default: 40000)'),
    layers: z
      .array(z.enum(['fixed', 'shortTerm', 'associative', 'spare']))
      .max(4)
      .optional()
      .describe('Context layers to include'),
  };
}

export interface ToolArguments {
  action: (typeof ACTIONS)[number];
  query?: string;
  topK?: number;
  language?: string;
  path?: string;
  force?: boolean;
  label?: string;
  backupId?: string;
  searchBackups?: boolean;
  maxAge?: number;
  maxCount?: number;
  pattern?: string;
  offset?: number;
  limit?: number;
  activeFile?: string;
  budget?: number;
  layers?: string[];
}
