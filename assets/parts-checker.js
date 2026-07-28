(function () {
  const $ = (id) => document.getElementById(id);

  const brandProfiles = {
    dell: {
      name: "Dell",
      serialName: "service tag",
      hints: ["latitude", "inspiron", "xps", "precision", "alienware", "vostro", "dell"],
      touchHints: ["2-in-1", "2 in 1", "touch", "7420 2-in-1", "7390 2-in-1", "9310 2-in-1"],
      support: ({ serial }) => `https://www.dell.com/support/home/en-us/product-support/servicetag/${encodeURIComponent(serial)}/overview`,
      parts: "https://www.dell.com/en-us/shop/partsforyourdell",
      sources: [
        {
          title: "Parts-People",
          description: "Dell-specific supplier with service-tag matching for shipped parts.",
          url: "https://www.parts-people.com/",
        },
      ],
    },
    hp: {
      name: "HP",
      serialName: "serial",
      hints: ["elitebook", "probook", "pavilion", "envy", "spectre", "omen", "zbook", "hp "],
      touchHints: ["x360", "2-in-1", "2 in 1", "touch", "spectre folio"],
      support: () => "https://support.hp.com/us-en/check-warranty",
      parts: "https://partsurfer.hp.com/",
      sources: [
        {
          title: "HP Parts Store",
          description: "Official HP parts store for genuine HP replacement parts.",
          url: "https://parts.hp.com/",
        },
      ],
    },
    lenovo: {
      name: "Lenovo",
      serialName: "serial",
      hints: ["thinkpad", "ideapad", "yoga", "legion", "loq", "lenovo"],
      touchHints: ["yoga", "flex", "duet", "2-in-1", "2 in 1", "touch"],
      support: () => "https://support.lenovo.com/us/en/parts-lookup",
      parts: "https://support.lenovo.com/us/en/parts-lookup",
    },
    apple: {
      name: "Apple",
      serialName: "serial",
      hints: ["macbook", "macbook pro", "macbook air", "apple"],
      nonTouchHints: ["macbook", "macbook pro", "macbook air"],
      support: () => "https://checkcoverage.apple.com/",
      parts: "https://support.apple.com/mac/repair",
    },
    asus: {
      name: "ASUS",
      serialName: "serial",
      hints: ["vivobook", "zenbook", "rog", "tuf", "asus"],
      touchHints: ["flip", "2-in-1", "2 in 1", "touch"],
      support: () => "https://www.asus.com/support/",
      parts: "https://www.asus-accessories.com/",
    },
    acer: {
      name: "Acer",
      serialName: "SNID or serial",
      hints: ["aspire", "swift", "spin", "predator", "travelmate", "acer"],
      touchHints: ["spin", "2-in-1", "2 in 1", "touch"],
      support: () => "https://www.acer.com/us-en/support",
      parts: "https://www.capitaldatausa.com/acer-laptops/",
    },
    msi: {
      name: "MSI",
      serialName: "serial",
      hints: ["msi", "stealth", "raider", "katana", "modern", "prestige"],
      support: () => "https://account.msi.com/services/product-support",
      parts: "https://us-store.msi.com/",
    },
    microsoft: {
      name: "Microsoft Surface",
      serialName: "serial",
      hints: ["surface", "microsoft"],
      touchHints: ["surface"],
      support: () => "https://account.microsoft.com/devices",
      parts: "https://www.microsoft.com/en-us/store/b/surface-repair-parts",
    },
    samsung: {
      name: "Samsung",
      serialName: "serial",
      hints: ["galaxy book", "samsung", "np"],
      touchHints: ["360", "2-in-1", "2 in 1", "touch"],
      support: () => "https://www.samsung.com/us/support/service/",
      parts: "https://samsungparts.com/",
    },
  };

  const universalSources = [
    {
      title: "LaptopScreen.com",
      description: "Model-based replacement panels with connector and finish notes.",
      url: (query) => `https://www.laptopscreen.com/English/section/search/?q=${encodeURIComponent(query)}`,
    },
    {
      title: "Panelook",
      description: "Panel database for LCD codes like B156HAN, LP140WF, and NV156.",
      url: (query) => `https://www.panelook.com/sizmodlist.php?keyword=${encodeURIComponent(query)}`,
    },
    {
      title: "Google Shopping",
      description: "Compare suppliers after size, resolution, and touch are confirmed.",
      url: (query) => `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}`,
    },
    {
      title: "eBay Parts",
      description: "Good for OEM display assemblies, used pulls, and rare brackets.",
      url: (query) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`,
    },
  ];

  const knownLaptopMatchers = [
    {
      brand: "hp",
      name: "HP Pavilion x360 Convertible 14m-dw1013dx",
      family: "HP Pavilion x360 14-dw",
      touch: "touch",
      aliases: ["14-dw1013dx", "14m-dw1013dx"],
      supportUrl: "https://support.hp.com/si-en/drivers/hp-pavilion-x360-convertible-laptop-pc-14m-dw1000/model/2100019236",
      test: (key) => key.includes("14dw1013dx") || key.includes("14mdw1013dx"),
      sources: [
        {
          title: "LaptopScreen exact screen",
          description: "Exact model page for the HP Pavilion x360 14-dw1013dx display assembly.",
          url: "https://www.laptopscreen.com/English/model/HP/PAVILION~X360~14-DW1013DX/",
        },
        {
          title: "Bliss Computers assembly",
          description: "Touch screen assembly listings for HP Pavilion x360 14m-dw1013dx.",
          url: "https://www.blisscomputers.net/14-hp-pavilion-x360-14m-dw0013dx-14m-dw1013dx-lcd-touch-screen-replacement-225816/",
        },
      ],
    },
  ];

  const form = $("partsCheckerForm");
  if (!form) return;

  const els = {
    empty: $("partsCheckerEmpty"),
    results: $("partsCheckerResults"),
    brand: $("partsCheckerBrand"),
    device: $("partsCheckerDevice"),
    confidenceLabel: $("partsConfidenceLabel"),
    confidenceScore: $("partsConfidenceScore"),
    confidenceBar: $("partsConfidenceBar"),
    checklist: $("partsChecklist"),
    links: $("partsLinks"),
    laptopMatch: $("partsLaptopMatch"),
    queries: $("partsQueries"),
    copy: $("partsCopySearch"),
    touch: $("partsTouch"),
    touchHint: $("partsTouchHint"),
    touchField: $("partsTouchField"),
    touchAuto: $("partsTouchAuto"),
    touchAutoValue: $("partsTouchAutoValue"),
    message: $("partsFormMessage"),
  };

  let activeSearch = "";

  function clean(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function modelKey(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findKnownLaptop(model) {
    const key = modelKey(model);
    return knownLaptopMatchers.find((item) => item.test(key)) || null;
  }

  function detectBrand(model, selectedBrand) {
    if (selectedBrand !== "auto") return selectedBrand;
    const known = findKnownLaptop(model);
    if (known) return known.brand;
    const haystack = model.toLowerCase();
    const match = Object.entries(brandProfiles).find(([, profile]) =>
      profile.hints.some((hint) => haystack.includes(hint))
    );
    if (/\b\d{2}-[a-z]{2}\d{4}[a-z]{2}\b/i.test(model)) return "hp";
    return match ? match[0] : "unknown";
  }

  function detectTouchStatus(model, serial, brand) {
    const known = findKnownLaptop(model);
    if (known?.touch) return { value: known.touch, source: "exact-model" };
    const haystack = `${model} ${serial}`.toLowerCase();
    const profile = brandProfiles[brand];
    const touchHints = [
      ...(profile?.touchHints || []),
      "touchscreen",
      "touch screen",
    ];
    const nonTouchHints = [
      ...(profile?.nonTouchHints || []),
      "non-touch",
      "non touch",
      "without touch",
      "no touch",
    ];

    if (nonTouchHints.some((hint) => haystack.includes(hint))) {
      return { value: "non-touch", source: "inferred" };
    }
    if (touchHints.some((hint) => haystack.includes(hint))) {
      return { value: "touch", source: "inferred" };
    }
    return { value: "", source: "manual" };
  }

  function syncTouchField() {
    const model = clean($("partsModel")?.value);
    const serial = clean($("partsSerial")?.value);
    const brand = detectBrand(model, "auto");
    const detected = detectTouchStatus(model, serial, brand);

    if (detected.value) {
      els.touch.value = detected.value;
      els.touch.disabled = true;
      els.touch.required = false;
      els.touchField.hidden = true;
      els.touchAuto.hidden = false;
      els.touchAutoValue.textContent = `${touchLabel(detected.value)} auto-detected`;
    } else {
      if (els.touch.disabled) els.touch.value = "";
      els.touch.disabled = false;
      els.touch.required = true;
      els.touchField.hidden = false;
      els.touchAuto.hidden = true;
      els.touchAutoValue.textContent = "";
      els.touchHint.textContent = "Choose this only when the model/serial does not identify the display type.";
    }
  }

  function touchLabel(value) {
    return value === "touch" ? "Touch" : "Non-touch";
  }

  function formatLaptopName(data, profile) {
    if (data.exactLaptop?.name) return data.exactLaptop.name;
    const model = clean(data.model);
    if (!profile) return model;
    const brandTokens = profile.name.toLowerCase().split(/\s+/);
    const modelText = model.toLowerCase();
    const alreadyNamed = brandTokens.some((token) => modelText === token || modelText.startsWith(`${token} `));
    return alreadyNamed ? model : `${profile.name} ${model}`;
  }

  function scoreConfidence(data) {
    let score = 55;
    if (data.exactLaptop) score += 15;
    if (data.brand !== "unknown") score += 18;
    if (data.touch) score += data.touchSource === "manual" ? 12 : 17;
    if (data.serial.length >= 5) score += 10;
    return Math.min(score, 100);
  }

  function buildQueries(data, profile) {
    const laptopName = formatLaptopName(data, profile);
    const touchTerm = data.touch === "touch" ? "touchscreen" : "non-touch";
    const aliasTerm = data.exactLaptop?.aliases?.join(" ") || data.model;
    return [
      `${laptopName} ${data.serial} ${touchTerm} LCD screen replacement`,
      `${laptopName} ${touchTerm} display assembly part number`,
      `${laptopName} ${touchTerm} laptop screen`,
      `${aliasTerm} ${data.serial} ${touchTerm} OEM LCD panel`,
    ]
      .map(clean)
      .filter((value, index, list) => value.length > 8 && list.indexOf(value) === index);
  }

  function buildExactSearchUrl(data, profile) {
    const query = clean(`${formatLaptopName(data, profile)} ${data.serial}`);
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }

  function renderLaptopMatch(data, profile) {
    const serialLabel = profile?.serialName || "serial";
    const supportUrl = data.exactLaptop?.supportUrl || profile?.support(data) || buildExactSearchUrl(data, profile);
    const laptopName = formatLaptopName(data, profile);
    const rows = [
      ["Laptop", laptopName],
      ...(data.exactLaptop?.family ? [["Family", data.exactLaptop.family]] : []),
      [serialLabel, data.serial],
      ["Display", touchLabel(data.touch)],
      ["Touch source", data.touchSource === "manual" ? "Selected" : "Auto-detected"],
    ];

    els.laptopMatch.innerHTML = `
      <div class="parts-laptop-name">
        <svg class="icon"><use href="#i-laptop"></use></svg>
        <strong>${escapeHtml(laptopName)}</strong>
      </div>
      <dl>
        ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
      <div class="parts-laptop-actions">
        <a class="primary-btn" href="${escapeHtml(supportUrl)}" target="_blank" rel="noreferrer">
          <svg class="icon"><use href="#i-search"></use></svg>Open exact lookup
        </a>
        <a class="ghost-btn" href="${escapeHtml(buildExactSearchUrl(data, profile))}" target="_blank" rel="noreferrer">
          Search web
        </a>
      </div>
    `;
  }

  function renderChecklist(data, profile) {
    const items = [
      {
        title: `Verify ${profile?.serialName || "serial"} on manufacturer support`,
        body: "The serial or service tag is the strongest source for the as-built display option.",
      },
      {
        title: `Display type: ${touchLabel(data.touch)}`,
        body: data.touchSource === "manual"
          ? "Touch status was selected manually because the identifiers did not make it clear."
          : "Touch status was inferred from the model/serial, so the form did not need to ask.",
      },
      {
        title: "Match size, resolution, connector, and bracket style",
        body: "Use the manufacturer parts page or original panel code to confirm the exact compatible screen before ordering.",
      },
      {
        title: "Use a full display assembly when cabling or glass differs",
        body: "Panel-only swaps are best after the original LCD code and connector side are confirmed.",
      },
    ];

    els.checklist.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span>`;
      return li;
    }));
  }

  function renderLinks(data, query, profile) {
    const exactSources = data.exactLaptop ? [
      {
        title: "HP exact laptop support",
        description: "Exact HP support page for this Pavilion x360 model.",
        url: data.exactLaptop.supportUrl,
      },
      ...(data.exactLaptop.sources || []),
    ] : [];
    const brandLinks = profile ? [
      {
        title: `${profile.name} exact lookup`,
        description: `Lookup by ${profile.serialName} for original configuration and parts.`,
        url: profile.support(data),
      },
      {
        title: `${profile.name} Parts`,
        description: "Manufacturer or trusted route for assemblies and official part numbers.",
        url: profile.parts,
      },
      ...(profile.sources || []),
    ] : [];

    const seen = new Set();
    const sources = [
      ...exactSources,
      ...brandLinks,
      ...universalSources.map((source) => ({ ...source, url: source.url(query) })),
    ].filter((source) => {
      const key = `${source.title}|${source.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    els.links.replaceChildren(...sources.map((source) => {
      const card = document.createElement("a");
      card.className = "parts-link-card";
      card.href = source.url;
      card.target = "_blank";
      card.rel = "noreferrer";
      card.innerHTML = `<strong>${escapeHtml(source.title)}</strong><span>${escapeHtml(source.description)}</span>`;
      return card;
    }));
  }

  function renderQueries(searches) {
    els.queries.replaceChildren(...searches.map((search) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "parts-query";
      item.textContent = search;
      item.addEventListener("click", async () => {
        await copyText(search);
        toast("Search copied.");
      });
      return item;
    }));
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  function toast(message) {
    if (window.RPC_TOAST) window.RPC_TOAST(message);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;",
    })[char]);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const model = clean(formData.get("model"));
    const serial = clean(formData.get("serial"));
    const exactLaptop = findKnownLaptop(model);
    const brand = detectBrand(model, "auto");
    const touchDetection = detectTouchStatus(model, serial, brand);
    const touch = touchDetection.value || formData.get("touch");
    if (!touch) {
      els.message.textContent = "Select touch or non-touch before searching.";
      els.message.hidden = false;
      els.touch.focus();
      return;
    }
    els.message.hidden = true;

    const data = {
      model,
      serial,
      brand,
      touch,
      touchSource: touchDetection.value ? touchDetection.source : "manual",
      exactLaptop,
    };

    const profile = brandProfiles[data.brand];
    const searches = buildQueries(data, profile);
    const score = scoreConfidence(data);
    activeSearch = searches[0] || "";

    els.brand.textContent = data.exactLaptop
      ? "Exact laptop match"
      : profile
        ? `${profile.name} ${touchLabel(data.touch)} match packet`
        : `${touchLabel(data.touch)} match packet`;
    els.device.textContent = `${formatLaptopName(data, profile)} / ${data.serial}`;
    els.confidenceLabel.textContent = "Lookup confidence before manufacturer confirmation";
    els.confidenceScore.textContent = `${score}%`;
    els.confidenceBar.style.width = `${score}%`;

    renderChecklist(data, profile);
    renderLaptopMatch(data, profile);
    renderLinks(data, activeSearch, profile);
    renderQueries(searches);

    els.empty.hidden = true;
    els.results.hidden = false;
  });

  els.copy?.addEventListener("click", async () => {
    if (!activeSearch) return;
    await copyText(activeSearch);
    els.copy.innerHTML = '<svg class="icon"><use href="#i-check"></use></svg>Copied';
    window.setTimeout(() => {
      els.copy.innerHTML = '<svg class="icon"><use href="#i-clipboard"></use></svg>Copy';
    }, 1200);
  });

  ["partsModel", "partsSerial"].forEach((id) => {
    $(id)?.addEventListener("input", syncTouchField);
  });
  syncTouchField();
})();
