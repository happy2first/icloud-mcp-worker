export function mountCodeInputs(doc: Document, disabled: () => boolean) {
  const inputs = Array.from(
    doc.querySelectorAll<HTMLInputElement>("[data-code-digit]"),
  );
  const focus = (index: number) => {
    inputs[index]?.focus();
    inputs[index]?.select();
  };
  const fill = (index: number, text: string) => {
    const digits = text.replace(/[^0-9]/g, "").slice(0, 6);
    if (!digits) {
      inputs[index].value = "";
      return;
    }
    const start = digits.length === 6 ? 0 : index;
    if (digits.length > 1)
      inputs.slice(start).forEach((input) => {
        input.value = "";
      });
    for (let i = 0; i < digits.length && start + i < inputs.length; i++)
      inputs[start + i].value = digits[i];
    focus(Math.min(start + digits.length, inputs.length - 1));
  };
  inputs.forEach((input, index) => {
    input.addEventListener("input", () => {
      if (disabled()) {
        input.value = "";
        return;
      }
      fill(index, input.value);
    });
    input.addEventListener("paste", (event) => {
      event.preventDefault();
      if (!disabled()) fill(index, event.clipboardData?.getData("text") ?? "");
    });
    input.addEventListener("keydown", (event) => {
      if (disabled()) return;
      if (event.key === "Backspace" && !input.value && index > 0) {
        event.preventDefault();
        inputs[index - 1].value = "";
        focus(index - 1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        focus(
          Math.max(
            0,
            Math.min(
              inputs.length - 1,
              index + (event.key === "ArrowLeft" ? -1 : 1),
            ),
          ),
        );
      }
    });
    input.addEventListener("focus", () => input.select());
  });
  return {
    clear: () =>
      inputs.forEach((input) => {
        input.value = "";
      }),
    read: () => inputs.map((input) => input.value).join(""),
    focus: () => focus(0),
  };
}
