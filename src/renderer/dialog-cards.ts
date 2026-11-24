import type { OmpDialogRequest, OmpDialogResponse } from "../shared/contracts";

export interface OpenUrlPromptItem {
  url: string;
  displayUrl: string;
  instructions?: string;
}

export function buildNoConfiguredModelCard(onDismiss: () => void): HTMLElement {
  const card = document.createElement("section");
  card.className = "onboarding-card";
  card.dataset.testid = "onboarding-card";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "OMP model setup required");

  const header = document.createElement("div");
  header.className = "onboarding-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "onboarding-title-wrap";

  const badge = document.createElement("span");
  badge.className = "dialog-badge warning";
  badge.textContent = "NO_CONFIGURED_MODEL";

  const title = document.createElement("h3");
  title.className = "onboarding-title";
  title.textContent = "Configure an OMP model or provider before chatting";
  titleWrap.append(badge, title);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "icon-btn";
  dismissBtn.dataset.testid = "dismiss-onboarding-btn";
  dismissBtn.setAttribute("aria-label", "Dismiss setup guide");
  dismissBtn.textContent = "\u00d7";
  dismissBtn.addEventListener("click", onDismiss);

  header.append(titleWrap, dismissBtn);

  const intro = document.createElement("p");
  intro.className = "onboarding-text";
  intro.textContent =
    "OMP exited before entering RPC mode because no default model or provider credential is configured yet. OMP Desktop never copies or stores your API keys — configure OMP directly using one of these methods:";

  const list = document.createElement("ol");
  list.className = "onboarding-steps";

  const step1 = document.createElement("li");
  step1.textContent =
    "Run `omp` in PowerShell or terminal and execute `/login` to sign in with your preferred provider.";

  const step2 = document.createElement("li");
  step2.textContent =
    "Or set a provider environment variable (such as ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY) before launching OMP Desktop.";

  const step3 = document.createElement("li");
  step3.textContent =
    "Or define a provider and default model in `~/.omp/agent/models.yml`, then send your message again.";

  list.append(step1, step2, step3);
  card.append(header, intro, list);
  return card;
}

export function buildOpenUrlCard(
  item: OpenUrlPromptItem,
  onOpen: (url: string) => Promise<void>,
  onDismiss: () => void,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "dialog-card";
  card.dataset.testid = "open-url-card";

  const header = document.createElement("div");
  header.className = "dialog-header";

  const badge = document.createElement("span");
  badge.className = "dialog-badge";
  badge.textContent = "EXTERNAL AUTH / URL";

  const title = document.createElement("strong");
  title.className = "dialog-title";
  title.textContent = "OMP requested opening an external URL";
  header.append(badge, title);
  card.append(header);

  if (item.instructions) {
    const inst = document.createElement("p");
    inst.className = "dialog-description";
    inst.textContent = item.instructions;
    card.append(inst);
  }

  const urlBox = document.createElement("pre");
  urlBox.className = "dialog-code";
  urlBox.textContent = item.displayUrl;
  card.append(urlBox);

  const actions = document.createElement("div");
  actions.className = "dialog-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "btn btn-primary";
  openBtn.dataset.testid = "open-url-confirm-btn";
  openBtn.textContent = "Open in Isolated Browser";
  openBtn.addEventListener("click", async () => {
    openBtn.disabled = true;
    await onOpen(item.url);
    onDismiss();
  });

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "btn btn-subtle";
  dismissBtn.dataset.testid = "open-url-dismiss-btn";
  dismissBtn.textContent = "Dismiss";
  dismissBtn.addEventListener("click", onDismiss);

  actions.append(openBtn, dismissBtn);
  card.append(actions);
  return card;
}

export function buildOmpDialogCard(
  request: OmpDialogRequest,
  onRespond: (response: OmpDialogResponse) => Promise<void>,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "dialog-card";
  card.dataset.testid = `dialog-card-${request.id}`;
  card.dataset.dialogMethod = request.method;
  card.setAttribute("role", "group");

  const controlsToDisable: Array<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement> = [];
  const lockControls = (): void => {
    for (const el of controlsToDisable) {
      el.disabled = true;
    }
  };

  const header = document.createElement("div");
  header.className = "dialog-header";

  const badge = document.createElement("span");
  badge.className = "dialog-badge";
  badge.textContent =
    request.method === "confirm"
      ? "APPROVAL REQUIRED"
      : request.method === "ask"
        ? "QUESTIONS"
        : request.method.toUpperCase();

  const title = document.createElement("strong");
  title.className = "dialog-title";
  title.textContent =
    request.method === "ask"
      ? "OMP needs your input before continuing"
      : request.method === "form"
        ? "Unsupported form dialog"
        : request.title;

  header.append(badge, title);

  if (typeof request.timeoutMs === "number" && request.timeoutMs > 0) {
    const timeoutMeta = document.createElement("span");
    timeoutMeta.className = "dialog-timeout";
    timeoutMeta.textContent = `${Math.ceil(request.timeoutMs / 1000)}s timeout`;
    header.append(timeoutMeta);
  }
  card.append(header);

  if (request.method === "confirm") {
    if (request.message) {
      const msg = document.createElement("pre");
      msg.className = "dialog-code";
      msg.dataset.testid = "dialog-confirm-message";
      msg.textContent = request.message;
      card.append(msg);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "btn btn-primary";
    approveBtn.dataset.testid = "dialog-approve-btn";
    approveBtn.textContent = "Approve";

    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "btn btn-danger";
    denyBtn.dataset.testid = "dialog-deny-btn";
    denyBtn.textContent = "Deny";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-subtle";
    cancelBtn.dataset.testid = "dialog-cancel-btn";
    cancelBtn.textContent = "Cancel";

    controlsToDisable.push(approveBtn, denyBtn, cancelBtn);

    approveBtn.addEventListener("click", async () => {
      lockControls();
      await onRespond({ id: request.id, kind: "confirm", confirmed: true });
    });
    denyBtn.addEventListener("click", async () => {
      lockControls();
      await onRespond({ id: request.id, kind: "confirm", confirmed: false });
    });
    cancelBtn.addEventListener("click", async () => {
      lockControls();
      await onRespond({ id: request.id, kind: "cancel" });
    });

    actions.append(approveBtn, denyBtn, cancelBtn);
    card.append(actions);
    return card;
  }

  if (request.method === "select") {
    const isMulti = request.selectionMarker === "checkbox";
    const optionsWrap = document.createElement("div");
    optionsWrap.className = "dialog-options";

    const inputs: HTMLInputElement[] = [];
    const defaultRadioIdx =
      typeof request.initialIndex === "number" &&
      request.initialIndex >= 0 &&
      request.initialIndex < request.options.length
        ? request.initialIndex
        : 0;
    const initialChecked = new Set(request.checkedIndices ?? []);

    request.options.forEach((optText, idx) => {
      const labelEl = document.createElement("label");
      labelEl.className = "dialog-option-row";

      const input = document.createElement("input");
      input.type = isMulti ? "checkbox" : "radio";
      input.name = `omp-select-${request.id}`;
      input.value = optText;
      input.dataset.testid = `dialog-select-option-${idx}`;
      input.checked = isMulti ? initialChecked.has(idx) : idx === defaultRadioIdx;

      if (isMulti && typeof request.markableCount === "number" && request.markableCount > 0) {
        input.addEventListener("change", () => {
          const checkedCount = inputs.filter((el) => el.checked).length;
          if (checkedCount > request.markableCount!) {
            input.checked = false;
          }
        });
      }

      inputs.push(input);
      controlsToDisable.push(input);

      const textGroup = document.createElement("div");
      textGroup.className = "dialog-option-text";

      const mainLabel = document.createElement("span");
      mainLabel.className = "dialog-option-label";
      mainLabel.textContent = optText;
      textGroup.append(mainLabel);

      const detail = request.optionDetails?.[idx]?.description;
      if (detail) {
        const desc = document.createElement("span");
        desc.className = "dialog-option-desc";
        desc.textContent = detail;
        textGroup.append(desc);
      }

      labelEl.append(input, textGroup);
      optionsWrap.append(labelEl);
    });

    card.append(optionsWrap);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn btn-primary";
    submitBtn.dataset.testid = "dialog-submit-btn";
    submitBtn.textContent = "Confirm Selection";
    submitBtn.disabled = request.options.length === 0;

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-subtle";
    cancelBtn.dataset.testid = "dialog-cancel-btn";
    cancelBtn.textContent = "Cancel";

    controlsToDisable.push(submitBtn, cancelBtn);

    submitBtn.addEventListener("click", async () => {
      const selected = inputs.filter((el) => el.checked).map((el) => el.value);
      if (!isMulti && selected.length === 0) {
        return;
      }
      lockControls();
      const value = isMulti ? selected.join("\n") : (selected[0] ?? "");
      await onRespond({ id: request.id, kind: "value", value });
    });

    cancelBtn.addEventListener("click", async () => {
      lockControls();
      await onRespond({ id: request.id, kind: "cancel" });
    });

    actions.append(submitBtn, cancelBtn);
    card.append(actions);
    return card;
  }

  if (request.method === "input" || request.method === "editor") {
    const isSecret = request.secret === true;
    if (isSecret) {
      const secretNote = document.createElement("p");
      secretNote.className = "dialog-secret-note";
      secretNote.dataset.testid = "dialog-secret-note";
      secretNote.textContent =
        "Secret input is masked and sent directly to the local OMP process over stdin — never logged or persisted by OMP Desktop.";
      card.append(secretNote);
    }

    let field: HTMLInputElement | HTMLTextAreaElement;
    if (request.method === "editor" && !isSecret) {
      const area = document.createElement("textarea");
      area.className = "dialog-textarea";
      area.rows = 4;
      area.placeholder = request.placeholder ?? "";
      area.dataset.testid = "dialog-editor-input";
      field = area;
    } else {
      const inp = document.createElement("input");
      inp.type = isSecret ? "password" : "text";
      inp.className = "dialog-input";
      inp.autocomplete = isSecret ? "new-password" : "off";
      inp.spellcheck = false;
      inp.placeholder = request.placeholder ?? "";
      inp.dataset.testid = isSecret ? "dialog-secret-input" : "dialog-text-input";
      field = inp;
    }

    controlsToDisable.push(field);
    card.append(field);

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn btn-primary";
    submitBtn.dataset.testid = "dialog-submit-btn";
    submitBtn.textContent = "Submit";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-subtle";
    cancelBtn.dataset.testid = "dialog-cancel-btn";
    cancelBtn.textContent = "Cancel";

    controlsToDisable.push(submitBtn, cancelBtn);

    const submitValue = async (): Promise<void> => {
      const val = field.value;
      lockControls();
      if (isSecret) {
        field.value = "";
      }
      await onRespond({ id: request.id, kind: "value", value: val });
    };

    if (field instanceof HTMLInputElement) {
      field.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          void submitValue();
        }
      });
    }

    submitBtn.addEventListener("click", () => {
      void submitValue();
    });

    cancelBtn.addEventListener("click", async () => {
      lockControls();
      if (isSecret) {
        field.value = "";
      }
      await onRespond({ id: request.id, kind: "cancel" });
    });

    actions.append(submitBtn, cancelBtn);
    card.append(actions);
    return card;
  }

  if (request.method === "ask") {
    const questionCollectors: Array<() => {
      id: string;
      selectedOptions: string[];
      customInput?: string;
    }> = [];

    for (const q of request.questions) {
      const qBlock = document.createElement("div");
      qBlock.className = "dialog-question-block";
      qBlock.dataset.testid = `dialog-ask-question-${q.id}`;

      if (q.header) {
        const qHeader = document.createElement("div");
        qHeader.className = "dialog-question-header";
        qHeader.textContent = q.header;
        qBlock.append(qHeader);
      }

      const qTitle = document.createElement("div");
      qTitle.className = "dialog-question-title";
      qTitle.textContent = q.question;
      qBlock.append(qTitle);

      const qOptions = document.createElement("div");
      qOptions.className = "dialog-options";

      const isMulti = q.multi === true;
      const optionInputs: HTMLInputElement[] = [];
      const defaultIdx =
        typeof q.recommended === "number" && q.recommended >= 0 && q.recommended < q.options.length
          ? q.recommended
          : 0;

      q.options.forEach((opt, idx) => {
        const row = document.createElement("label");
        row.className = "dialog-option-row";

        const input = document.createElement("input");
        input.type = isMulti ? "checkbox" : "radio";
        input.name = `omp-ask-${request.id}-${q.id}`;
        input.value = opt.label;
        input.dataset.testid = `dialog-ask-opt-${q.id}-${idx}`;
        input.checked = !isMulti && q.options.length > 0 && idx === defaultIdx;

        optionInputs.push(input);
        controlsToDisable.push(input);

        const textWrap = document.createElement("div");
        textWrap.className = "dialog-option-text";

        const labelLine = document.createElement("span");
        labelLine.className = "dialog-option-label";
        labelLine.textContent =
          q.recommended === idx ? `${opt.label} (Recommended)` : opt.label;
        textWrap.append(labelLine);

        if (opt.description) {
          const desc = document.createElement("span");
          desc.className = "dialog-option-desc";
          desc.textContent = opt.description;
          textWrap.append(desc);
        }

        row.append(input, textWrap);
        qOptions.append(row);
      });

      qBlock.append(qOptions);

      const customInput = document.createElement("input");
      customInput.type = "text";
      customInput.className = "dialog-input dialog-custom-input";
      customInput.placeholder = "Optional write-in response...";
      customInput.dataset.testid = `dialog-ask-custom-${q.id}`;
      controlsToDisable.push(customInput);
      qBlock.append(customInput);

      questionCollectors.push(() => {
        const selectedOptions = optionInputs.filter((i) => i.checked).map((i) => i.value);
        const trimmedCustom = customInput.value.trim();
        return {
          id: q.id,
          selectedOptions,
          ...(trimmedCustom ? { customInput: trimmedCustom } : {}),
        };
      });

      card.append(qBlock);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn btn-primary";
    submitBtn.dataset.testid = "dialog-submit-btn";
    submitBtn.textContent = "Submit Answers";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-subtle";
    cancelBtn.dataset.testid = "dialog-cancel-btn";
    cancelBtn.textContent = "Cancel";

    controlsToDisable.push(submitBtn, cancelBtn);

    submitBtn.addEventListener("click", async () => {
      lockControls();
      const answers = questionCollectors.map((fn) => fn());
      await onRespond({ id: request.id, kind: "ask", answers });
    });

    cancelBtn.addEventListener("click", async () => {
      lockControls();
      await onRespond({ id: request.id, kind: "cancel" });
    });

    actions.append(submitBtn, cancelBtn);
    card.append(actions);
    return card;
  }

  // Fallback for any unexpected dialog variant: allow explicit cancel without ever rendering raw HTML
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-subtle";
  cancelBtn.dataset.testid = "dialog-cancel-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    await onRespond({ id: request.id, kind: "cancel" });
  });
  actions.append(cancelBtn);
  card.append(actions);
  return card;
}
