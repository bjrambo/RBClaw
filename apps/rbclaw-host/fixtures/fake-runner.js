// Protocol fixture for testing the C# to Bun process boundary without an agent account.
const input = JSON.parse(await Bun.stdin.text());
console.log('---RBCLAW_OUTPUT_START---');
console.log(
  JSON.stringify({ status: 'success', result: `echo:${input.prompt}` }),
);
console.log('---RBCLAW_OUTPUT_END---');
