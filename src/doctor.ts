import { loadConfig, requireApiKey } from "./config.js";
import { createJevClient } from "./jev.js";
import { connectPlaywright } from "./playwright.js";

export const runDoctor = async (): Promise<string> => {
  const config = loadConfig();
  const lines: string[] = [];
  lines.push(`provider: ${config.provider}`);
  lines.push(`model: ${config.model}`);
  lines.push(`base: ${config.baseUrl}`);
  lines.push(`key: ${config.apiKey ? "present" : "MISSING"}`);
  lines.push(`text model: ${config.textModel}`);
  lines.push(
    `playwright: ${config.playwright.command} ${config.playwright.args.join(" ")}`,
  );

  requireApiKey(config);
  const jev = createJevClient(config);
  const decision = await jev.decide(
    { ping: "doctor" },
    {
      alive: {
        type: "noul",
        instructions: "Is this a connectivity check that should succeed?",
        criteria: { true: "This is a health check", false: "This is a real user task" },
      },
    },
  );
  const noul = decision.answers.alive?.type === "noul" ? decision.answers.alive.noul : 0;
  lines.push(`jev decision: ok (noul=${noul.toFixed(2)}, tokens=${decision.usage.inputTokens})`);

  try {
    const browser = await connectPlaywright(config);
    const groupId = await browser.createGroup("jev-doctor");
    const targetId = await browser.newTab(groupId, "about:blank");
    lines.push(`playwright: ok group=${groupId} targetId=${targetId}`);
    await browser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`playwright: FAILED ${message}`);
  }

  return lines.join("\n");
};
