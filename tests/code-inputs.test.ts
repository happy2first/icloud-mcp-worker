import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { mountCodeInputs } from "../src/auth/code-inputs.ts";
import { credentialDocument } from "../src/auth/credential-page.ts";
async function setup() {
  const { document, window } = parseHTML(
    await credentialDocument(
      new Request("https://synthetic.test/connect/apple"),
      {},
    ).text(),
  );
  const inputs = Array.from(
    document.querySelectorAll("[data-code-digit]"),
  ) as any[];
  let focused = -1,
    disabled = false;
  inputs.forEach((input, i) => {
    input.focus = () => {
      focused = i;
    };
    input.select = () => {};
  });
  const code = mountCodeInputs(document as unknown as Document, () => disabled);
  const event = (name: string, fields: any = {}) =>
    Object.assign(new window.Event(name, { cancelable: true }), fields);
  return {
    inputs,
    code,
    event,
    focused: () => focused,
    disable: () => {
      disabled = true;
    },
  };
}
test("OTP uses six visible labelled numeric inputs and advances while typing", async () => {
  const h = await setup();
  assert.equal(h.inputs.length, 6);
  for (let i = 0; i < 6; i++) {
    const input = h.inputs[i];
    assert.equal(input.getAttribute("type"), "text");
    assert.equal(input.getAttribute("inputmode"), "numeric");
    assert.ok(input.getAttribute("aria-label").includes(String(i + 1)));
    input.value = String(i + 1);
    input.dispatchEvent(h.event("input"));
    assert.equal(h.focused(), Math.min(i + 1, 5));
  }
  assert.equal(h.code.read(), "123456");
});
test("paste and mobile full-code autofill distribute digits, including from a middle box", async () => {
  const h = await setup();
  h.inputs[3].dispatchEvent(
    h.event("paste", { clipboardData: { getData: () => "123 456" } }),
  );
  assert.equal(h.code.read(), "123456");
  h.code.clear();
  h.inputs[0].value = "654321";
  h.inputs[0].dispatchEvent(h.event("input"));
  assert.equal(h.code.read(), "654321");
  h.code.clear();
  assert.equal(h.code.read(), "");
});
test("empty backspace clears previous digit and arrow keys navigate within bounds", async () => {
  const h = await setup();
  h.inputs[0].value = "1";
  h.inputs[1].dispatchEvent(h.event("keydown", { key: "Backspace" }));
  assert.equal(h.inputs[0].value, "");
  assert.equal(h.focused(), 0);
  h.inputs[0].dispatchEvent(h.event("keydown", { key: "ArrowLeft" }));
  assert.equal(h.focused(), 0);
  h.inputs[5].dispatchEvent(h.event("keydown", { key: "ArrowRight" }));
  assert.equal(h.focused(), 5);
});
test("disabled verification ignores paste and nonnumeric input is not retained", async () => {
  const h = await setup();
  h.inputs[0].value = "x";
  h.inputs[0].dispatchEvent(h.event("input"));
  assert.equal(h.code.read(), "");
  h.disable();
  h.inputs[0].dispatchEvent(
    h.event("paste", { clipboardData: { getData: () => "123456" } }),
  );
  assert.equal(h.code.read(), "");
});
