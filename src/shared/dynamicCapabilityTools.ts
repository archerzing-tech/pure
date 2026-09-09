import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import type { ToolDefinition } from './types';

export interface DynamicMcpConnectionResult {
  tools: ToolDefinition[];
  persisted: boolean;
}

export interface DynamicCapabilityHooks {
  connectMcpServer(config: MCPServerConfig, signal?: AbortSignal): Promise<DynamicMcpConnectionResult>;
}

export const DYNAMIC_CAPABILITY_TOOL_DEFS: readonly ToolDefinition[] = [
  {
    name: 'search_agent_skills',
    description: 'Search community Agent Skills for the current business need. Returns matching skill names, descriptions, sources, and install ids. Use this when the current skills do not cover a required capability.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability or business need to search for, such as OCR, PDF extraction, product design, or data analysis' },
        maxResults: { type: 'integer', description: 'Maximum candidates to return, from 1 to 20 (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'install_agent_skill',
    description: 'Download and install an Agent Skill into the application skill directory (~/.pure/skills/). The skill becomes available to the current turn after installation. `source` accepts either a repo returned by search_agent_skills OR a GitHub repo the user provided ("owner/repo" or a full github.com URL) — a search hit is NOT required when the user names the repo. The fetch tries several routes automatically (raw CDN → GitHub API → repo zip), so one blocked host usually does not fail the install; if it still fails, switch transport (download the repo zip via download_file and extract to ~/.pure/skills/) instead of retrying.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Repository as owner/repo (e.g. anthropics/skills) or a full GitHub URL; from search_agent_skills results or from the user' },
        name: { type: 'string', description: 'Skill directory name, e.g. pdf. From search results, or derived from the user-provided repo/skill name' },
      },
      required: ['source', 'name'],
    },
  },
  {
    name: 'search_mcp_servers',
    description: 'Search MCP service catalogs for a business capability. Aggregates the official MCP Registry and public community search results, and marks which candidates have a directly usable stdio or HTTP connection recipe.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Business capability to search for, such as CRM, ticketing, database, browser automation, or document processing' },
        maxResults: { type: 'integer', description: 'Maximum candidates to return, from 1 to 20 (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'connect_mcp_server',
    description: 'Connect one MCP candidate returned by search_mcp_servers. This launches a third-party process or opens a remote service; the user must approve the connection before it runs. The connected tools are available immediately in the current turn.',
    input_schema: {
      type: 'object',
      properties: {
        candidateId: { type: 'string', description: 'Candidate id returned by search_mcp_servers' },
      },
      required: ['candidateId'],
    },
  },
] as const;

export const DYNAMIC_CAPABILITY_NAMES = new Set(
  DYNAMIC_CAPABILITY_TOOL_DEFS.map((tool) => tool.name),
);

export function isDynamicCapabilityTool(name: string): boolean {
  return DYNAMIC_CAPABILITY_NAMES.has(name);
}

export function dynamicCapabilityTool(name: string): ToolDefinition | undefined {
  return DYNAMIC_CAPABILITY_TOOL_DEFS.find((tool) => tool.name === name);
}
