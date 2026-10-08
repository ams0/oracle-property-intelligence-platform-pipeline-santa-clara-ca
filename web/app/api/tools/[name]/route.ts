import { NextResponse } from "next/server";
import { TOOLS, type ToolName } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Plain HTTP mirror of the MCP tools (same schemas) for the explorer UI and quick curl checks. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const tool = TOOLS[name as ToolName];
  if (!tool) return NextResponse.json({ error: `unknown tool ${name}`, tools: Object.keys(TOOLS) }, { status: 404 });
  const parsed = tool.input.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json(await tool.run(parsed.data as never));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 422 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const tool = TOOLS[name as ToolName];
  if (!tool) return NextResponse.json({ tools: Object.keys(TOOLS) }, { status: 404 });
  return NextResponse.json({ name, title: tool.title, description: tool.description });
}
