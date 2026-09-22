import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

describe("workspace SBOM", () => {
  it("records resolved direct and transitive production dependency versions", async () => {
    await execFileAsync(process.execPath, ["scripts/security/generate-sbom.mjs"], {
      cwd: repoRoot,
    });
    const sbom = JSON.parse(
      await readFile(
        path.join(repoRoot, "artifacts", "security", "sbom.cyclonedx.json"),
        "utf8",
      ),
    ) as {
      components: Array<{ name: string; version: string }>;
    };

    expect(componentVersion(sbom, "@modelcontextprotocol/sdk")).toBe("1.30.0");
    expect(componentVersion(sbom, "@hono/node-server")).toBe("2.0.10");
    expect(componentVersion(sbom, "fast-uri")).toBe("3.1.8");
    expect(componentVersion(sbom, "hono")).toBe("4.13.8");
    expect(componentVersion(sbom, "ip-address")).toBe("10.3.1");
  });
});

function componentVersion(
  sbom: { components: Array<{ name: string; version: string }> },
  name: string,
): string | undefined {
  return sbom.components.find((component) => component.name === name)?.version;
}
