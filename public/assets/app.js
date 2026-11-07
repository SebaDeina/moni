// Plataforma de Moni: login por WhatsApp y panel. Sin dependencias.
(function () {
  const $ = (id) => document.getElementById(id);
  const STATUS = {
    proposed: { text: "Esperando tu SI", tone: "" },
    confirmed: { text: "Enviando", tone: "" },
    sent: { text: "Enviada", tone: "" },
    failed: { text: "No salió", tone: "alerta" },
    expired: { text: "Venció", tone: "alerta" },
  };
  const CONFIRM_WINDOW_MS = 2 * 60 * 1000;
  let period = "week";
  let pollTimer = null;

  async function api(path, options = {}) {
    const res = await fetch("/api" + path, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : {},
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Algo salió mal. Probá de nuevo."), { status: res.status });
    return data;
  }

  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  };
  const extLink = (url, text) => el("a", { href: url, target: "_blank", rel: "noopener", textContent: text });
  /** "0.4999999998324848 AVAX" → "0,5 AVAX", "12.5 USDC" → "12,50 USDC". */
  const avax = (s) => {
    const [num, unit = "AVAX"] = String(s).trim().split(/\s+/);
    const n = Number(num);
    if (!Number.isFinite(n)) return s;
    const opts = unit === "USDC" ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 4 };
    const shown = unit !== "USDC" && n > 0 && n < 0.0001 ? "< 0,0001" : n.toLocaleString("es-AR", opts);
    return shown + " " + unit;
  };
  const isZero = (s) => Number(String(s).trim().split(/\s+/)[0]) === 0;
  /** Nombres conocidos para direcciones: el contrato y la agenda. */
  const names = new Map();
  const nameOf = (address) => names.get(address.toLowerCase()) || short(address);
  const when = (ms) =>
    new Date(ms).toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  function addressWithCopy(address, url) {
    const copy = el("button", { className: "copy", type: "button", textContent: "Copiar" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(address);
        copy.textContent = "Copiada";
      } catch {
        copy.textContent = address;
      }
      setTimeout(() => (copy.textContent = "Copiar"), 1500);
    });
    return el("span", { className: "addr" }, extLink(url, short(address) + " ↗"), copy);
  }

  // ---------- Login ----------
  // Por defecto, al revés: abrimos WhatsApp con "Entrar a Moni: <código>" y esta página espera el mensaje.
  // Si Moni no tiene número publicado, queda el login de siempre (número → código por WhatsApp).
  let pendingPhone = "";
  let waLink = null; // https://wa.me/<número de Moni>, de /api/public
  let waTimer = null;
  let waStartedAt = 0;
  const LOGIN_STEPS = ["step-wa-start", "step-wa-wait", "step-phone", "step-code"];

  function showStep(id) {
    for (const s of LOGIN_STEPS) $(s).hidden = s !== id;
    if (id !== "step-wa-wait") stopWaPolling();
  }

  function showLogin() {
    $("view-app").hidden = true;
    $("who").hidden = true;
    $("view-login").hidden = false;
    $("use-wa").hidden = !waLink;
    showStep(waLink ? "step-wa-start" : "step-phone");
  }

  function stopWaPolling() {
    clearTimeout(waTimer);
    waTimer = null;
  }

  async function pollWaLogin() {
    stopWaPolling();
    let r;
    try {
      r = await api("/auth/whatsapp");
    } catch {
      r = { status: "pending" }; // un error de red no corta la espera
    }
    if (r.status === "ready") return loadApp();
    if (r.status === "pending" && r.code) {
      const text = "Entrar a Moni: " + r.code;
      $("wa-code").textContent = text;
      if (waLink) $("wa-reopen").href = waLink + "?text=" + encodeURIComponent(text);
    }
    // La cookie la pone la pestaña que abre WhatsApp: los primeros segundos puede no estar todavía.
    if (r.status === "expired" && Date.now() - waStartedAt > 15000) {
      showStep(waLink ? "step-wa-start" : "step-phone");
      $("phone-error").textContent = "";
      return;
    }
    if (!$("step-wa-wait").hidden) waTimer = setTimeout(pollWaLogin, 2000);
  }

  function waitForWhatsApp() {
    waStartedAt = Date.now();
    $("wa-code").textContent = "Entrar a Moni: ······";
    $("wa-reopen").href = "/api/auth/whatsapp/go";
    showStep("step-wa-wait");
    waTimer = setTimeout(pollWaLogin, 1500);
  }

  $("wa-login").addEventListener("click", waitForWhatsApp);
  $("wa-cancel").addEventListener("click", () => showStep("step-phone"));
  $("use-code").addEventListener("click", () => showStep("step-phone"));
  $("use-wa").addEventListener("click", () => showStep("step-wa-start"));
  // Al volver de WhatsApp (sobre todo en el celular) chequeamos enseguida.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("step-wa-wait").hidden) pollWaLogin();
  });

  $("form-phone").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    $("phone-error").textContent = "";
    try {
      pendingPhone = $("phone").value;
      const r = await api("/auth/request", { method: "POST", body: JSON.stringify({ phone: pendingPhone }) });
      $("sent-to").textContent = r.sentTo;
      showStep("step-code");
      $("code").focus();
    } catch (err) {
      $("phone-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("form-code").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    $("code-error").textContent = "";
    try {
      await api("/auth/verify", { method: "POST", body: JSON.stringify({ phone: pendingPhone, code: $("code").value }) });
      $("code").value = "";
      await loadApp();
    } catch (err) {
      $("code-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("change-phone").addEventListener("click", () => showStep("step-phone"));

  $("logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    clearInterval(pollTimer);
    showLogin();
  });

  // ---------- Panel ----------
  async function loadApp() {
    let me;
    try {
      me = await api("/me");
    } catch (err) {
      if (err.status === 401) return showLogin();
      throw err;
    }
    $("view-login").hidden = true;
    $("view-app").hidden = false;
    $("who").hidden = false;
    $("who-phone").textContent = me.phone;

    const b = me.balances;
    $("balance-usdc").textContent = b ? avax(b.USDC) : "—";
    $("balance").textContent = b ? avax(b.AVAX) : "";
    $("balance").title = b ? b.AVAX : "";
    $("balance").hidden = !b;
    $("balance-note").hidden = Boolean(b);
    $("balance-note").textContent = me.wallet
      ? "No pude leer el saldo de Avalanche. Probá de nuevo en un rato."
      : "Todavía no tenés wallet. Creala acá o pedíselo a Moni por WhatsApp: te regalamos un poco de AVAX de prueba y el gas lo paga Moni.";
    $("create-wallet-box").hidden = Boolean(me.wallet);
    $("max").textContent = avax(me.maxTransfer.USDC) + " · " + avax(me.maxTransfer.AVAX);
    if (me.wallet) $("wallet").replaceChildren(addressWithCopy(me.wallet.address, me.wallet.url));

    const pub = await api("/public").catch(() => null);
    if (pub && pub.contract) {
      $("contract").replaceChildren(addressWithCopy(pub.contract.address, pub.contract.url));
      names.set(pub.contract.address.toLowerCase(), "MoniVault (contrato)");
    }

    renderContacts(me.contacts);

    await loadActivity();
    clearInterval(pollTimer);
    pollTimer = setInterval(loadActivity, 5000);
  }

  $("create-wallet").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Creando…";
    $("wallet-error").textContent = "";
    try {
      const r = await api("/wallet", { method: "POST" });
      if (r.funding && r.funding.error) $("wallet-error").textContent = r.funding.error;
      await loadApp();
    } catch (err) {
      $("wallet-error").textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Crear mi wallet";
    }
  });

  // ---------- Destinatario: un contacto o una dirección pegada ----------
  const OTHER_ADDRESS = "__address";
  function syncAddressField() {
    const other = $("send-alias").value === OTHER_ADDRESS;
    $("send-address").hidden = !other;
    $("send-address").required = other;
  }
  $("send-alias").addEventListener("change", syncAddressField);

  // ---------- Agenda ----------
  function renderContacts(contacts) {
    for (const c of contacts) names.set(c.address.toLowerCase(), c.alias);
    const select = $("send-alias");
    const current = select.value;
    select.replaceChildren(
      ...contacts.map((c) => el("option", { value: c.alias, textContent: c.alias })),
      el("option", { value: OTHER_ADDRESS, textContent: "Otra dirección…" }),
    );
    syncAddressField();
    if (contacts.some((c) => c.alias === current)) select.value = current;
    $("contacts-count").textContent = contacts.length ? String(contacts.length) : "";
    $("contacts").replaceChildren(
      ...(contacts.length
        ? contacts.map((c) => {
            const side = el("span", { className: "side" }, extLink(c.url, short(c.address) + " ↗"));
            if (c.shared) side.append(el("span", { className: "chip", textContent: "compartido" }));
            else side.append(removeButton(c.alias));
            return el("div", { className: "item" }, el("span", { className: "what", textContent: c.alias }), side);
          })
        : [el("p", { className: "empty", textContent: "Todavía no hay contactos. Agregá el primero acá abajo o pedíselo a Moni por WhatsApp." })]),
    );
  }

  /** Borrar pide dos clics: el primero cambia el texto a "¿Borrar?". */
  function removeButton(alias) {
    const btn = el("button", { className: "remove", type: "button", textContent: "Borrar" });
    btn.addEventListener("click", async () => {
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "¿Borrar?";
        setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Borrar"; }, 3000);
        return;
      }
      btn.disabled = true;
      try {
        await api("/contacts/" + encodeURIComponent(alias), { method: "DELETE" });
        await refreshContacts();
      } catch (err) {
        $("contact-error").textContent = err.message;
        btn.disabled = false;
      }
    });
    return btn;
  }

  async function refreshContacts() {
    const me = await api("/me");
    renderContacts(me.contacts);
  }

  $("form-contact").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    $("contact-error").textContent = "";
    try {
      await api("/contacts", {
        method: "POST",
        body: JSON.stringify({ alias: $("contact-alias").value, address: $("contact-address").value }),
      });
      $("contact-alias").value = "";
      $("contact-address").value = "";
      await refreshContacts();
    } catch (err) {
      $("contact-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function statusOf(op) {
    if (op.status === "proposed" && Date.now() - op.createdAt > CONFIRM_WINDOW_MS) return STATUS.expired;
    return STATUS[op.status] || { text: op.status, tone: "" };
  }

  async function loadActivity() {
    let data;
    try {
      data = await api("/me/activity?period=" + period);
    } catch (err) {
      if (err.status === 401) return showLogin();
      return;
    }
    const rows = [];
    for (const op of data.operations) {
      const s = statusOf(op);
      rows.push({
        at: op.createdAt,
        node: el(
          "div",
          { className: "item" },
          el("span", { className: "what", textContent: "Envío a " + op.alias }),
          el("span", { className: "side" }, el("span", { className: "amt", textContent: "−" + avax(op.amount) })),
          el("span", { className: "when", textContent: when(op.createdAt) }),
          el("span", { className: "side" }, op.txUrl ? extLink(op.txUrl, "Ver en Snowtrace ↗") : el("span", { className: "chip" + (s.tone ? " " + s.tone : ""), textContent: s.text })),
        ),
      });
    }
    // Un envío de Moni ya aparece como operación: no lo repetimos como transacción de la red.
    const known = new Set(data.operations.map((op) => op.txUrl).filter(Boolean));
    for (const tx of data.transactions || []) {
      if (known.has(tx.url)) continue;
      const sign = isZero(tx.amount) ? "" : tx.direction === "in" ? "+" : "−";
      rows.push({
        at: tx.timestamp,
        node: el(
          "div",
          { className: "item" },
          el("span", {
            className: "what",
            textContent:
              isZero(tx.amount) && tx.direction === "out"
                ? "Operación con " + nameOf(tx.counterparty)
                : (tx.direction === "in" ? "Recibiste de " : "Mandaste a ") + nameOf(tx.counterparty),
          }),
          el("span", { className: "side" }, el("span", { className: "amt", textContent: sign + avax(tx.amount) })),
          el("span", {
            className: "when",
            textContent: when(tx.timestamp) + (tx.success ? "" : " · falló") + (tx.direction === "out" && !isZero(tx.gas) ? " · gas " + avax(tx.gas) : ""),
          }),
          el("span", { className: "side" }, extLink(tx.url, "Ver ↗")),
        ),
      });
    }
    rows.sort((a, b) => b.at - a.at);
    const note = data.transactions === null ? el("p", { className: "empty", textContent: "Los movimientos de la red van a aparecer acá cuando termine la conexión con Avalanche." }) : null;
    $("activity").replaceChildren(
      ...(rows.length ? rows.map((r) => r.node) : [el("p", { className: "empty", textContent: "Todavía no hay movimientos en este período." })]),
      ...(note ? [note] : []),
    );
  }

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      period = b.dataset.period;
      document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      loadActivity();
    }),
  );

  $("form-send").addEventListener("submit", async (e) => {
    e.preventDefault();
    const notice = $("send-notice");
    const btn = $("send-btn");
    btn.disabled = true;
    notice.hidden = true;
    try {
      const r = await api("/transfers", {
        method: "POST",
        body: JSON.stringify({
          alias: $("send-alias").value === OTHER_ADDRESS ? $("send-address").value.trim() : $("send-alias").value,
          amount: $("send-amount").value,
          token: $("send-token").value,
        }),
      });
      notice.className = "notice";
      notice.replaceChildren(
        el("b", { textContent: "Te mandé un WhatsApp para confirmar." }),
        el("span", { textContent: `Tocá Confirmar (o respondé "sí") para mandarle ${avax(r.amount)} a ${r.alias}. Vence en 2 minutos.` }),
      );
      $("send-amount").value = "";
      loadActivity();
    } catch (err) {
      notice.className = "notice alerta";
      notice.replaceChildren(el("span", { textContent: err.message }));
    } finally {
      notice.hidden = false;
      btn.disabled = false;
    }
  });

  // Al cargar: con sesión, el panel. Sin sesión, si hay un login por WhatsApp en curso (por ejemplo, se
  // abrió desde la landing o desde el link que manda Moni), lo retomamos.
  async function start() {
    const pub = await api("/public").catch(() => ({}));
    waLink = pub.whatsapp ? pub.whatsapp.link : null;
    try {
      await api("/me");
      return loadApp();
    } catch (err) {
      if (err.status !== 401) throw err;
    }
    const wa = await api("/auth/whatsapp").catch(() => ({ status: "expired" }));
    if (wa.status === "ready") return loadApp();
    showLogin();
    // ?wa=1: venimos de la landing, que acaba de abrir WhatsApp en otra pestaña (la cookie puede tardar).
    const fromLanding = new URLSearchParams(location.search).has("wa");
    if (fromLanding) history.replaceState(null, "", "/app");
    if (wa.status === "pending" || (fromLanding && waLink)) {
      waitForWhatsApp();
      pollWaLogin();
    }
  }

  start().catch(() => showLogin());
})();
