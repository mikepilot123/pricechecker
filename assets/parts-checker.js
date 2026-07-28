(function () {
  const $ = (id) => document.getElementById(id);

  const brandProfiles = {
    dell: {
      name: "Dell",
      serialName: "service tag",
      hints: ["latitude", "inspiron", "xps", "precision", "alienware", "vostro", "dell"],
      support: ({ serial }) => `https://www.dell.com/support/home/en-us/product-support/servicetag/${encodeURIComponent(serial)}/overview`,
      parts: "https://www.parts-people.com/index.php?action=category&id=140&subid=screen",
    },
    hp: {
      name: "HP",
      serialName: "serial",
      hints: ["elitebook", "probook", "pavilion", "envy", "spectre", "omen", "zbook", "hp "],
      support: () => "https://support.hp.com/us-en/check-warranty",
      parts: "https://partsurfer.hp.com/",
    },
    lenovo: {
      name: "Lenovo",
      serialName: "serial",
      hints: ["thinkpad", "ideapad", "yoga", "legion", "loq", "lenovo"],
      support: () => "https://support.lenovo.com/us/en/parts-lookup",
      parts: "https://support.lenovo.com/us/en/parts-lookup",
    },
    apple: {
      name: "Apple",
      serialName: "serial",
      hints: ["macbook", "macbook pro", "macbook air", "apple"],
      support: () => "https://checkcoverage.apple.com/",
      parts: "https://support.apple.com/mac/repair",
    },
    asus: {
      name: "ASUS",
      serialName: "serial",
      hints: ["vivobook", "zenbook", "rog", "tuf", "asus"],
      support: () => "https://www.asus.com/support/",
      parts: "https://www.asus-accessories.com/",
    },
    acer: {
      name: "Acer",
      serialName: "SNID or serial",
      hints: ["aspire", "swift", "spin", "predator", "travelmate", "acer"],
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
      support: () => "https://account.microsoft.com/devices",
      parts: "https://www.microsoft.com/en-us/store/b/surface-repair-parts",
    },
    samsung: {
      name: "Samsung",
      serialName: "serial",
      hints: ["galaxy book", "samsung", "np"],
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
    queries: $("partsQueries"),
    copy: $("partsCopySearch"),
  };

  let activeSearch = "";

  function clean(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function detectBrand(model, selectedBrand) {
    if (selectedBrand !== "auto") return selectedBrand;
    const haystack = model.toLowerCase();
    const match = Object.entries(brandProfiles).find(([, profile]) =>
      profile.hints.some((hint) => haystack.includes(hint))
    );
    return match ? match[0] : "unknown";
  }

  function scoreConfidence(data) {
    let score = 42;
    if (data.brand !== "unknown") score += 18;
    if (data.size) score += 10;
    if (data.touch) score += 8;
    if (data.resolution) score += 12;
    if (data.pins) score += 10;
    return Math.min(score, 100);
  }

  function buildQueries(data, profile) {
    const brandName = profile?.name || "";
    const specTerms = [data.size, data.touch, data.resolution, data.pins].filter(Boolean).join(" ");
    return [
      `${brandName} ${data.model} ${data.serial} LCD screen replacement`,
      `${brandName} ${data.model} display assembly part number`,
      `${brandName} ${data.model} ${specTerms} laptop screen`,
      `${data.model} ${data.serial} OEM LCD panel`,
    ]
      .map(clean)
      .filter((value, index, list) => value.length > 8 && list.indexOf(value) === index);
  }

  function renderChecklist(data, profile) {
    const items = [
      {
        title: `Verify ${profile?.serialName || "serial"} on manufacturer support`,
        body: "The serial or service tag is the strongest source for the as-built display option.",
      },
      {
        title: "Match size, resolution, and connector",
        body: "The same model can ship with different touch, brightness, refresh, and pin layouts.",
      },
      {
        title: "Use a full assembly when cabling or glass differs",
        body: "Panel-only swaps are best after the original LCD code and connector side are confirmed.",
      },
      {
        title: data.pins ? `Connector target: ${data.pins}` : "Confirm connector before ordering",
        body: "30-pin and 40-pin eDP panels are not interchangeable, and touch panels often need different cabling.",
      },
    ];

    els.checklist.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span>`;
      return li;
    }));
  }

  function renderLinks(data, query, profile) {
    const brandLinks = profile ? [
      {
        title: `${profile.name} Support`,
        description: `Lookup by ${profile.serialName} for original configuration and parts.`,
        url: profile.support(data),
      },
      {
        title: `${profile.name} Parts`,
        description: "Manufacturer or trusted route for assemblies and official part numbers.",
        url: profile.parts,
      },
    ] : [];

    const sources = [
      ...brandLinks,
      ...universalSources.map((source) => ({ ...source, url: source.url(query) })),
    ];

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
    const data = {
      model: clean(formData.get("model")),
      serial: clean(formData.get("serial")),
      brand: detectBrand(clean(formData.get("model")), formData.get("brand")),
      size: formData.get("size"),
      touch: formData.get("touch"),
      resolution: formData.get("resolution"),
      pins: formData.get("pins"),
    };

    const profile = brandProfiles[data.brand];
    const searches = buildQueries(data, profile);
    const score = scoreConfidence(data);
    activeSearch = searches[0] || "";

    els.brand.textContent = profile ? `${profile.name} match packet` : "Brand not detected";
    els.device.textContent = `${data.model} / ${data.serial}`;
    els.confidenceLabel.textContent = "Lookup confidence before manufacturer confirmation";
    els.confidenceScore.textContent = `${score}%`;
    els.confidenceBar.style.width = `${score}%`;

    renderChecklist(data, profile);
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
})();
