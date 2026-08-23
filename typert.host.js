/**
 * dsh-memory-manager — Typert Host manifest.
 *
 * Hand-written TYPERT manifest (the format the DSH typert-loader consumes from
 * the package's `./typert` export). It describes the `memoryManager` Remote
 * service the Host half publishes so the browser Client half can call it
 * through `ctx.remote.memoryManager.{list,get,create,update,delete,importZCode}`.
 *
 * Keep the invocation ids, service/namespace names and method names in sync
 * with `index.js` (MemoryService) and `client.js`.
 */

import { z } from "zod";

// ---- shared shapes ---------------------------------------------------------

const errorSchema = z.object({
  code: z.string().readonly(),
  message: z.string().readonly().optional(),
}).readonly();

const memoryItemSchema = z.object({
  id: z.string().readonly(),
  name: z.string().readonly(),
  description: z.string().readonly(),
  type: z.string().readonly(),
  project: z.string().readonly(),
  label: z.string().readonly().optional(),
  origin: z.string().readonly(),
  createdAt: z.number().readonly(),
  updatedAt: z.number().readonly(),
  body: z.string().readonly().optional(),
  size: z.number().readonly().optional(),
}).readonly();

const projectSummarySchema = z.object({
  key: z.string().readonly(),
  label: z.string().readonly(),
  count: z.number().readonly(),
}).readonly();

const statsSchema = z.object({
  total: z.number().readonly(),
  byType: z.record(z.string(), z.number()).readonly(),
}).readonly();

const listValueSchema = z.object({
  items: z.array(memoryItemSchema).readonly(),
  projects: z.array(projectSummarySchema).readonly(),
  stats: statsSchema,
  workspaces: z.array(z.string()).readonly(),
  types: z.array(z.string()).readonly(),
  globalProject: z.string().readonly(),
}).readonly();

const itemResultSchema = z.union([
  z.object({
    ok: z.literal(true).readonly(),
    value: z.object({ item: memoryItemSchema }).readonly(),
  }).readonly(),
  z.object({
    ok: z.literal(false).readonly(),
    error: errorSchema,
  }).readonly(),
]);

const importValueSchema = z.object({
  imported: z.number().readonly(),
  skipped: z.number().readonly(),
  total: z.number().readonly(),
  projects: z.array(z.object({
    source: z.string().readonly(),
    project: z.string().readonly(),
    imported: z.number().readonly(),
    skipped: z.number().readonly(),
  }).readonly()).readonly(),
}).readonly();

const importResultSchema = z.union([
  z.object({
    ok: z.literal(true).readonly(),
    value: importValueSchema,
  }).readonly(),
  z.object({
    ok: z.literal(false).readonly(),
    error: errorSchema,
  }).readonly(),
]);

const deleteResultSchema = z.union([
  z.object({
    ok: z.literal(true).readonly(),
    value: z.object({ deleted: z.literal(true).readonly() }).readonly(),
  }).readonly(),
  z.object({
    ok: z.literal(false).readonly(),
    error: errorSchema,
  }).readonly(),
]);

// ---- per-invocation parameter/result schemas -------------------------------

const _memoryManager_list_parameter_0$schema = z.object({
  query: z.string().optional().readonly(),
  project: z.string().optional().readonly(),
  type: z.string().optional().readonly(),
}).readonly();

const _memoryManager_get_parameter_0$schema = z.object({
  id: z.string().readonly(),
}).readonly();

const _memoryManager_create_parameter_0$schema = z.object({
  name: z.string().readonly(),
  description: z.string().optional().readonly(),
  type: z.string().optional().readonly(),
  project: z.string().optional().readonly(),
  origin: z.string().optional().readonly(),
  body: z.string().optional().readonly(),
}).readonly();

const _memoryManager_update_parameter_0$schema = z.object({
  id: z.string().readonly(),
  name: z.string().optional().readonly(),
  description: z.string().optional().readonly(),
  type: z.string().optional().readonly(),
  project: z.string().optional().readonly(),
  origin: z.string().optional().readonly(),
  body: z.string().optional().readonly(),
}).readonly();

const _memoryManager_delete_parameter_0$schema = z.object({
  id: z.string().readonly(),
}).readonly();

const _memoryManager_importZCode_parameter_0$schema = z.object({
  source: z.string().optional().readonly(),
}).readonly();

const configSchema = z.object({
  autoLoad: z.boolean().readonly(),
  injectBody: z.boolean().readonly(),
}).readonly();

const configResultSchema = z.union([
  z.object({
    ok: z.literal(true).readonly(),
    value: z.object({ config: configSchema }).readonly(),
  }).readonly(),
  z.object({
    ok: z.literal(false).readonly(),
    error: errorSchema,
  }).readonly(),
]);

const _memoryManager_setConfig_parameter_0$schema = z.object({
  autoLoad: z.boolean().optional().readonly(),
  injectBody: z.boolean().optional().readonly(),
}).readonly();

const listResultSchema = z.union([
  z.object({
    ok: z.literal(true).readonly(),
    value: listValueSchema,
  }).readonly(),
  z.object({
    ok: z.literal(false).readonly(),
    error: errorSchema,
  }).readonly(),
]);

export const TYPERT = {
  package: "@duke-dsh-plugins/dsh-memory-manager",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-memory-manager#memoryManager/list",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerListRequest",
            schema: _memoryManager_list_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerListResult",
        schema: listResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/get",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "get",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerGetRequest",
            schema: _memoryManager_get_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerGetResult",
        schema: itemResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/create",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "create",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerCreateRequest",
            schema: _memoryManager_create_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerCreateResult",
        schema: itemResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/update",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "update",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerUpdateRequest",
            schema: _memoryManager_update_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerUpdateResult",
        schema: itemResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/delete",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "delete",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerDeleteRequest",
            schema: _memoryManager_delete_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerDeleteResult",
        schema: deleteResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/importZCode",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "importZCode",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerImportZCodeRequest",
            schema: _memoryManager_importZCode_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerImportZCodeResult",
        schema: importResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/getConfig",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerGetConfigResult",
        schema: configResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-memory-manager#memoryManager/setConfig",
      service: "memoryManager",
      namespace: "memoryManager",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-memory-manager#MemoryManagerSetConfigRequest",
            schema: _memoryManager_setConfig_parameter_0$schema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-memory-manager#MemoryManagerSetConfigResult",
        schema: configResultSchema,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Persistent project memory service (ported from ZCode): list, get, create, update and delete ZCode-style markdown memories, and import an existing ZCode memory directory.",
        summary: "Persistent project memory service.",
        tags: [],
        jsDoc:
          "/**\n * Persistent project memory service (ported from ZCode).\n */",
        key: "memoryManager",
        exportName: "MemoryService",
        members: [
          {
            kind: "method",
            name: "list",
            signature:
              "@Remote('list') async list(request?: MemoryManagerListRequest): Promise<MemoryManagerListResult>",
            summary: "List memories with optional query/project/type filters plus project summaries and stats.",
            jsDoc:
              "/**\n * List memories with optional query/project/type filters plus project summaries and stats.\n * @param request - optional filters.\n * @returns the filtered items, project summaries, stats and workspace hints.\n */",
          },
          {
            kind: "method",
            name: "get",
            signature:
              "@Remote('get') async get(request: MemoryManagerGetRequest): Promise<MemoryManagerGetResult>",
            summary: "Read one memory by composite id `project/name` including its body.",
            jsDoc:
              "/**\n * Read one memory by composite id `project/name` including its body.\n * @param request - the composite id.\n * @returns the full memory item.\n */",
          },
          {
            kind: "method",
            name: "create",
            signature:
              "@Remote('create') async create(request: MemoryManagerCreateRequest): Promise<MemoryManagerCreateResult>",
            summary: "Create a new memory (name, optional description/type/project/body).",
            jsDoc:
              "/**\n * Create a new memory.\n * @param request - memory fields.\n * @returns the stored memory item.\n */",
          },
          {
            kind: "method",
            name: "update",
            signature:
              "@Remote('update') async update(request: MemoryManagerUpdateRequest): Promise<MemoryManagerUpdateResult>",
            summary: "Update an existing memory by composite id; partial fields overwrite.",
            jsDoc:
              "/**\n * Update an existing memory by composite id; partial fields overwrite.\n * @param request - id plus the fields to change.\n * @returns the updated memory item.\n */",
          },
          {
            kind: "method",
            name: "delete",
            signature:
              "@Remote('delete') async delete(request: MemoryManagerDeleteRequest): Promise<MemoryManagerDeleteResult>",
            summary: "Permanently delete one memory by composite id.",
            jsDoc:
              "/**\n * Permanently delete one memory by composite id.\n * @param request - the composite id.\n * @returns success or a business failure.\n */",
          },
          {
            kind: "method",
            name: "importZCode",
            signature:
              "@Remote('importZCode') async importZCode(request?: MemoryManagerImportZCodeRequest): Promise<MemoryManagerImportZCodeResult>",
            summary: "Import memories from an existing ZCode memory directory, deduplicated by project + name.",
            jsDoc:
              "/**\n * Import memories from an existing ZCode memory directory (`~/.zcode/cli/memories` by default),\n * deduplicated by project + name.\n * @param request - optional explicit source directory.\n * @returns import counts per project.\n */",
          },
          {
            kind: "method",
            name: "getConfig",
            signature:
              "@Remote('getConfig') async getConfig(): Promise<MemoryManagerGetConfigResult>",
            summary: "Read the plugin config (auto-load switch).",
            jsDoc:
              "/**\n * Read the plugin config (auto-load switch).\n * @returns the resolved config.\n */",
          },
          {
            kind: "method",
            name: "setConfig",
            signature:
              "@Remote('setConfig') async setConfig(request?: MemoryManagerSetConfigRequest): Promise<MemoryManagerSetConfigResult>",
            summary: "Update the plugin config (auto-load switch).",
            jsDoc:
              "/**\n * Update the plugin config (auto-load switch).\n * @param request - the fields to change.\n * @returns the resolved config.\n */",
          },
        ],
        types: [
          {
            name: "MemoryManagerListRequest",
            declaration:
              "export interface MemoryManagerListRequest {\n    readonly query?: string;\n    readonly project?: string;\n    readonly type?: string;\n}",
          },
          {
            name: "MemoryManagerGetRequest",
            declaration:
              "export interface MemoryManagerGetRequest {\n    readonly id: string;\n}",
          },
          {
            name: "MemoryManagerCreateRequest",
            declaration:
              "export interface MemoryManagerCreateRequest {\n    readonly name: string;\n    readonly description?: string;\n    readonly type?: string;\n    readonly project?: string;\n    readonly origin?: string;\n    readonly body?: string;\n}",
          },
          {
            name: "MemoryManagerUpdateRequest",
            declaration:
              "export interface MemoryManagerUpdateRequest {\n    readonly id: string;\n    readonly name?: string;\n    readonly description?: string;\n    readonly type?: string;\n    readonly project?: string;\n    readonly origin?: string;\n    readonly body?: string;\n}",
          },
          {
            name: "MemoryManagerDeleteRequest",
            declaration:
              "export interface MemoryManagerDeleteRequest {\n    readonly id: string;\n}",
          },
          {
            name: "MemoryManagerImportZCodeRequest",
            declaration:
              "export interface MemoryManagerImportZCodeRequest {\n    readonly source?: string;\n}",
          },
          {
            name: "MemoryManagerListResult",
            declaration:
              "export type MemoryManagerListResult = { ok: true; value: { items: readonly MemoryItem[]; projects: readonly { key: string; label: string; count: number }[]; stats: { total: number; byType: Record<string, number> }; workspaces: readonly string[]; types: readonly string[]; globalProject: string } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerGetResult",
            declaration:
              "export type MemoryManagerGetResult = { ok: true; value: { item: MemoryItem } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerCreateResult",
            declaration:
              "export type MemoryManagerCreateResult = { ok: true; value: { item: MemoryItem } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerUpdateResult",
            declaration:
              "export type MemoryManagerUpdateResult = { ok: true; value: { item: MemoryItem } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerDeleteResult",
            declaration:
              "export type MemoryManagerDeleteResult = { ok: true; value: { deleted: true } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerImportZCodeResult",
            declaration:
              "export type MemoryManagerImportZCodeResult = { ok: true; value: { imported: number; skipped: number; total: number; projects: readonly { source: string; project: string; imported: number; skipped: number }[] } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerGetConfigResult",
            declaration:
              "export type MemoryManagerGetConfigResult = { ok: true; value: { config: { autoLoad: boolean; injectBody: boolean } } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryManagerSetConfigRequest",
            declaration:
              "export interface MemoryManagerSetConfigRequest {\n    readonly autoLoad?: boolean;\n    readonly injectBody?: boolean;\n}",
          },
          {
            name: "MemoryManagerSetConfigResult",
            declaration:
              "export type MemoryManagerSetConfigResult = { ok: true; value: { config: { autoLoad: boolean; injectBody: boolean } } } | { ok: false; error: { code: string; message?: string } };",
          },
          {
            name: "MemoryItem",
            declaration:
              "export interface MemoryItem {\n    readonly id: string;\n    readonly name: string;\n    readonly description: string;\n    readonly type: string;\n    readonly project: string;\n    readonly label?: string;\n    readonly origin: string;\n    readonly createdAt: number;\n    readonly updatedAt: number;\n    readonly body?: string;\n    readonly size?: number;\n}",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
