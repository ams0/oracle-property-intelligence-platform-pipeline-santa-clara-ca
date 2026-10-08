import { createMcpHandler } from "mcp-handler";
import type { z } from "zod";
import { TOOLS } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ToolDef {
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (args: never) => Promise<unknown>;
}

const handler = createMcpHandler(
  (server) => {
    for (const [name, tool] of Object.entries(TOOLS) as [string, ToolDef][]) {
      const callback = async (args: unknown) => {
        try {
          const result = await tool.run(args as never);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
        }
      };
      server.registerTool(
        name,
        { title: tool.title, description: tool.description, inputSchema: tool.input.shape as never },
        callback as never,
      );
    }
  },
  { serverInfo: { name: "oracle-santa-clara", version: "1.0.0" } },
);

export { handler as GET, handler as POST, handler as DELETE };
