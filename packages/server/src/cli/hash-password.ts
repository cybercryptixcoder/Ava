import readline from "node:readline";
import { hashPassword } from "../security/crypto";

// Usage: npm run hash-password            (prompts, input hidden)
//        npm run hash-password -- 'secret' (non-interactive)
async function main() {
  let pw = process.argv[2];
  if (!pw) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write("Password: ");
    out._writeToOutput = () => out.output.write("");
    pw = await new Promise<string>((r) => rl.question("", (a) => r(a)));
    rl.close();
    process.stdout.write("\n");
  }
  if (!pw || pw.length < 8) {
    console.error("Use at least 8 characters.");
    process.exit(1);
  }
  console.log(`AVA_PASSWORD_HASH='${hashPassword(pw)}'`);
}
void main();
