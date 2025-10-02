import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "CreaPrompt_0_weight";
const EXT_NAME = "CreaPrompt_0_weight_UI";
const BASE = "/custom_nodes/creaprompt_weight"; // endpoints dédiés (csv & presets_w)

window.creaPromptRestores = [];
window._crea_prompt_launch_time = performance.now();

if (!window._crea_prompt_first_boot_done) {
    window._crea_prompt_first_boot_done = true;
    window._crea_prompt_is_refresh = true;
    window.addEventListener("DOMContentLoaded", () => {
        setTimeout(() => { window._crea_prompt_is_refresh = false; }, 2000);
    });
}

window._crea_prompt_refresh_done = false;

// ---------- Helpers ----------
function labelFromCsv(file) {
    // "001_style.csv" -> "style"
    return file.slice(3, -4);
}

// Hide a widget visually but KEEP it serialized
function hideButSerializeWidget(w) {
    if (!w) return;
    // do NOT touch w.serialize (must stay true/undefined)
    w.hidden = true;
    w.computeSize = () => [0, -4];
    w.draw = () => { };
    // harden any HTML input that Comfy may have added
    setTimeout(() => {
        try {
            if (w.inputEl) {
                w.inputEl.blur();
                w.inputEl.readOnly = true;
                w.inputEl.disabled = true;
                if (w.inputEl.parentElement) w.inputEl.parentElement.style.display = "none";
                w.inputEl.style.display = "none";
            }
        } catch { }
    }, 0);
}

function addComboAndWeight(node, label, values, initial = { value: "disabled", weight: 1 }) {
    if (!node._crea_dynamicValues) node._crea_dynamicValues = {};
    const rec = node._crea_dynamicValues[label] || {};
    if (typeof rec !== "object" || rec === null) {
        node._crea_dynamicValues[label] = { value: String(rec ?? initial.value), weight: initial.weight ?? 1 };
    } else {
        if (!("value" in rec)) rec.value = initial.value ?? "disabled";
        if (!("weight" in rec)) rec.weight = initial.weight ?? 1;
    }

    if (!node.widgets.some(w => w.name === label)) {
        node.addWidget("combo", label, node._crea_dynamicValues[label].value, (val) => {
            node._crea_dynamicValues[label].value = val;
            node._crea_updateCsvJson?.();
        }, { values, serialize: false });

        const wName = `${label}: Weight`;
        const weightW = node.addWidget(
            "number",
            wName,
            Number(node._crea_dynamicValues[label].weight ?? 1),
            (val) => {
                let num = Number(val);
                if (!Number.isFinite(num)) num = 1;
                if (num < -10) num = -10;
                if (num > 10) num = 10;
                num = Math.round(num * 100) / 100; // 2 déc.
                node._crea_dynamicValues[label].weight = num;
                node._crea_updateCsvJson?.();
            },
            { min: -10, max: 10, step: 0.1, precision: 2, serialize: false }
        );

        // Double-clic -> reset 1.00
        weightW.onDblClick = () => {
            node._crea_dynamicValues[label].weight = 1.00;
            weightW.value = 1.00;
            node._crea_updateCsvJson?.();
        };

        // placer le weight juste sous la combo
        try {
            const idx = node.widgets.findIndex(w => w.name === label);
            const last = node.widgets.pop();
            node.widgets.splice(idx + 1, 0, last);
        } catch { }

        node._crea_updateCsvJson?.();
        node.widgets_changed = true;
        node.onResize?.(node.size);
        node.graph?.setDirtyCanvas(true, true);
    }
}

async function fetchCsvList() {
    const res = await fetch(`${BASE}/csv_list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}
async function fetchCsvFile(file) {
    const res = await fetch(`${BASE}/csv/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}
async function fetchPresetsList() {
    const res = await fetch(`${BASE}/presets_list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}
async function fetchPresetFile(file) {
    const res = await fetch(`${BASE}/presets/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}
async function savePreset(name, content) {
    const res = await fetch(`${BASE}/save_preset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
async function deletePreset(file) {
    const res = await fetch(`${BASE}/delete_preset/${file}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ---------- Extension ----------
app.registerExtension({
    name: EXT_NAME,

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            const node = this;

            node._crea_dynamicValues = node._crea_dynamicValues || {};
            let clickX = 100, clickY = 100;

            // Hide __csv_json but keep it serialized (fix restore after F5)
            const jsonWidget = node.widgets.find(w => w.name === "__csv_json");
            hideButSerializeWidget(jsonWidget);

            // debounced serializer
            const updateCsvJson = (() => {
                let t;
                return () => {
                    clearTimeout(t);
                    t = setTimeout(() => {
                        if (jsonWidget) {
                            const clean = {};
                            for (const [k, v] of Object.entries(node._crea_dynamicValues || {})) {
                                if (v && typeof v === "object") {
                                    const w = Number.isFinite(Number(v.weight)) ? Math.round(Number(v.weight) * 100) / 100 : 1;
                                    clean[k] = { value: String(v.value ?? "disabled"), weight: w };
                                } else {
                                    clean[k] = { value: String(v ?? "disabled"), weight: 1 };
                                }
                            }
                            jsonWidget.value = JSON.stringify(clean);
                            // keep it hidden (in case Comfy re-attached an input)
                            hideButSerializeWidget(jsonWidget);
                        }
                        node.graph?.setDirtyCanvas(true, true);
                    }, 60);
                };
            })();
            node._crea_updateCsvJson = updateCsvJson;

            // --- (optionnel) ceinture de sécurité si un refresh a mal peuplé des champs ---
            // Avec le correctif ci-dessus, ça ne devrait plus arriver, on garde juste en backup.
            for (const w of node.widgets || []) {
                if (w.name === "Prompt_count" && (!Number.isFinite(w.value) || w.value < 1)) w.value = 1;
                if (w.name === "CreaPrompt_Collection" && (w.value !== "disabled" && w.value !== "enabled")) w.value = "disabled";
                if (w.name === "seed" && (!Number.isFinite(w.value))) w.value = 0;
                if (w.name === "control_before_generation" && (typeof w.value !== "string" || !w.value)) w.value = "randomize";
            }

            // ----- UI buttons -----
            if (!node._crea_savePresetAdded) {
                node._crea_savePresetAdded = true;

                node.addWidget("text", "📁 Enter Preset Name for Saving", "", (val) => {
                    node._crea_presetName = (val || "").trim();
                });

                node.addWidget("button", "💾 Save Categories Preset", "", async () => {
                    const name = node._crea_presetName;
                    if (!name || name.length < 2) return alert("❗Please enter a preset name.");
                    try {
                        await savePreset(name, JSON.stringify(node._crea_dynamicValues, null, 2));
                        alert(`✅ Preset "${name}" saved successfully !`);
                    } catch (e) {
                        alert("❌ Error saving preset : " + e.message);
                    }
                }, { serialize: false });
            }

            node.addWidget("button", "📂 Load Categories Preset", "", async () => {
                try {
                    if (window.event) { clickX = window.event.clientX; clickY = window.event.clientY; }
                    const files = (await fetchPresetsList()).filter(f => f.endsWith(".txt") && f !== "default_combos.txt");
                    if (!files.length) return alert("No preset found in /presets_w.");

                    const menu = document.createElement("div");
                    Object.assign(menu.style, {
                        position: "fixed", left: `${clickX}px`, top: `${clickY}px`,
                        background: "#222", color: "#fff", padding: "5px",
                        border: "1px solid #444", zIndex: 9999
                    });

                    const closeItem = document.createElement("div");
                    closeItem.innerText = "❌ Close menu";
                    Object.assign(closeItem.style, { padding: "4px", cursor: "pointer", fontWeight: "bold", borderBottom: "1px solid #ccc" });
                    closeItem.addEventListener("click", () => menu.remove());
                    menu.appendChild(closeItem);

                    files.forEach(file => {
                        const label = file.replace(/\.txt$/, "");
                        const item = document.createElement("div");
                        item.textContent = label;
                        item.style.padding = "4px 8px";
                        item.style.cursor = "pointer";
                        item.onclick = async () => {
                            try {
                                const content = await fetchPresetFile(file);
                                const parsed = JSON.parse(content); // {label:{value,weight}|string}

                                // clear existing dynamic widgets
                                const existingLabels = Object.keys(node._crea_dynamicValues || {});
                                for (const name of existingLabels) {
                                    const toRemove = node.widgets.filter(w => w.name === name || w.name === `${name}: Weight`);
                                    for (const w of toRemove) {
                                        const i = node.widgets.indexOf(w);
                                        if (i !== -1) {
                                            node.widgets.splice(i, 1);
                                            if (node.widgets_values) node.widgets_values.splice(i, 1);
                                        }
                                    }
                                }

                                // rebuild mapping
                                const allFiles = await fetchCsvList();
                                const fileMap = {};
                                for (const f of allFiles) fileMap[labelFromCsv(f)] = f;

                                node._crea_dynamicValues = {};
                                for (const [comboLabel, val] of Object.entries(parsed)) {
                                    const fileCsv = fileMap[comboLabel];
                                    if (!fileCsv) continue;
                                    const text = await fetchCsvFile(fileCsv);
                                    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
                                    const values = ["disabled", "🎲random", ...lines];

                                    let rec;
                                    if (typeof val === "object" && val) {
                                        rec = { value: String(val.value ?? "disabled"), weight: Number.isFinite(Number(val.weight)) ? Number(val.weight) : 1 };
                                    } else {
                                        rec = { value: String(val ?? "disabled"), weight: 1 };
                                    }
                                    node._crea_dynamicValues[comboLabel] = rec;
                                    addComboAndWeight(node, comboLabel, values, rec);
                                }

                                node._crea_updateCsvJson?.();
                                node.widgets_changed = true;
                                node.onResize?.(node.size);
                            } catch (e) { alert("❌ Error when loading : " + e.message); }
                            menu.remove();
                        };
                        item.onmouseover = () => item.style.background = "#555";
                        item.onmouseout = () => item.style.background = "#222";
                        menu.appendChild(item);
                    });

                    document.body.appendChild(menu);
                } catch (err) { alert("❌ Error when loading presets : " + err.message); }
            });

            node.addWidget("button", "🗑️ Delete Categories Preset", "", async () => {
                if (window.event) { clickX = window.event.clientX; clickY = window.event.clientY; }
                const existingMenu = document.getElementById("crea_delete_preset_menu");
                if (existingMenu) existingMenu.remove();

                try {
                    const files = (await fetchPresetsList()).filter(f => f.endsWith(".txt") && f !== "default_combos.txt");
                    if (!files.length) return alert("No preset found.");

                    const menu = document.createElement("div");
                    menu.id = "crea_delete_preset_menu";
                    Object.assign(menu.style, {
                        position: "fixed", left: `${clickX}px`, top: `${clickY}px`,
                        background: "#2c2c2c", color: "#fff", padding: "5px",
                        border: "1px solid #444", zIndex: 9999, fontFamily: "sans-serif", fontSize: "13px"
                    });

                    const closeItem = document.createElement("div");
                    closeItem.textContent = "❌ Close menu";
                    Object.assign(closeItem.style, { padding: "6px 12px", cursor: "pointer", fontWeight: "bold", borderBottom: "1px solid #555" });
                    closeItem.onclick = () => menu.remove();
                    menu.appendChild(closeItem);

                    files.forEach(file => {
                        const item = document.createElement("div");
                        const label = file.replace(/\.txt$/, "");
                        item.textContent = label;
                        item.style.padding = "4px 12px";
                        item.style.cursor = "pointer";
                        item.onclick = async () => {
                            if (!confirm(`Do you really want to delete the preset "${label}" ?`)) return;
                            try { await deletePreset(file); menu.remove(); }
                            catch (e) { alert("❌ Delete error : " + e.message); }
                        };
                        item.onmouseover = () => item.style.background = "#555";
                        item.onmouseout = () => item.style.background = "#2c2c2c";
                        menu.appendChild(item);
                    });

                    document.body.appendChild(menu);
                } catch (e) { alert("❌ Error when loading presets : " + e.message); }
            }, { serialize: false });

            // Remove All Categories
            if (!node._crea_removeAllAdded) {
                node._crea_removeAllAdded = true;
                node.addWidget("button", "🧹 Remove All Categories", "", () => {
                    const names = Object.keys(node._crea_dynamicValues || {});
                    if (!names.length) return alert("Aucun combo à supprimer.");
                    for (const name of names) {
                        const toRemove = node.widgets.filter(w => w.name === name || w.name === `${name}: Weight`);
                        for (const w of toRemove) {
                            const i = node.widgets.indexOf(w);
                            if (i !== -1) {
                                node.widgets.splice(i, 1);
                                if (node.widgets_values) node.widgets_values.splice(i, 1);
                            }
                        }
                        delete node._crea_dynamicValues[name];
                    }
                    node._crea_updateCsvJson?.();
                    node.widgets_changed = true;
                    const newSize = node.computeSize(); node.size[1] = newSize[1];
                    node.onResize?.(node.size);
                    node.graph.setDirtyCanvas(true, true);
                }, { serialize: false });
            }

            // Remove a Category
            node.addWidget("button", "➖ Remove a Category", "", () => {
                const existing = Object.keys(node._crea_dynamicValues || {});
                if (!existing.length) return alert("No combo to delete.");

                if (window.event) { clickX = window.event.clientX; clickY = window.event.clientY; }

                const oldMenu = document.getElementById("crea_remove_combo_menu");
                if (oldMenu) document.body.removeChild(oldMenu);

                const menu = document.createElement("div");
                menu.id = "crea_remove_combo_menu";
                const closeItem = document.createElement("div");
                closeItem.innerText = "❌ Close menu";
                Object.assign(closeItem.style, { padding: "4px", cursor: "pointer", fontWeight: "bold", borderBottom: "1px solid #ccc" });
                closeItem.addEventListener("click", () => document.body.removeChild(menu));
                menu.appendChild(closeItem);
                Object.assign(menu.style, {
                    position: "fixed", left: `${clickX}px`, top: `${clickY}px`,
                    background: "#222", color: "#fff", padding: "5px",
                    border: "1px solid #444", zIndex: 9999
                });

                existing.forEach(name => {
                    const item = document.createElement("div");
                    item.textContent = name;
                    item.style.padding = "4px 8px";
                    item.style.cursor = "pointer";
                    item.onclick = () => {
                        const toRemove = node.widgets.filter(w => w.name === name || w.name === `${name}: Weight`);
                        for (const w of toRemove) {
                            const i = node.widgets.indexOf(w);
                            if (i !== -1) {
                                node.widgets.splice(i, 1);
                                if (node.widgets_values) node.widgets_values.splice(i, 1);
                            }
                        }
                        delete node._crea_dynamicValues[name];
                        node._crea_updateCsvJson?.();
                        node.widgets_changed = true;
                        const newSize2 = node.computeSize(); node.size[1] = newSize2[1];
                        node.onResize?.(node.size);
                        node.graph.setDirtyCanvas(true, true);
                        menu.remove();
                    };
                    item.onmouseover = () => item.style.background = "#555";
                    item.onmouseout = () => item.style.background = "#222";
                    menu.appendChild(item);
                });
                document.body.appendChild(menu);
            }, { serialize: false });

            // Add a Category (CSV chooser)
            const addBtn = node.addWidget("button", "📂 Choose CSV file", "", async () => {
                if (window.event) { clickX = window.event.clientX; clickY = window.event.clientY; }
                if (node._csvMenu) { node._csvMenu.remove(); node._csvMenu = null; }

                try {
                    const csvFiles = (await fetchCsvList()).filter(f => f.endsWith(".csv"));
                    if (!csvFiles.length) return alert("No CSV file found in /csv.");

                    const menu = document.createElement("div");
                    menu.id = "crea_add_combo_menu";
                    Object.assign(menu.style, {
                        position: "fixed", left: `${clickX}px`, top: `${clickY}px`,
                        background: "#2c2c2c", color: "#eee", border: "1px solid #666",
                        padding: "4px 0", zIndex: 1000, fontFamily: "sans-serif", fontSize: "13px",
                        minWidth: "200px", maxHeight: "40vh", overflowY: "auto",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.5)", borderRadius: "4px"
                    });

                    const closeItem = document.createElement("div");
                    closeItem.textContent = "❌ Close menu";
                    Object.assign(closeItem.style, {
                        padding: "6px 12px", cursor: "pointer", fontWeight: "bold",
                        borderBottom: "1px solid #555", background: "#2c2c2c",
                        position: "sticky", top: "0", zIndex: "1001"
                    });
                    closeItem.onclick = () => { menu.remove(); node._csvMenu = null; };
                    menu.appendChild(closeItem);

                    for (const file of csvFiles) {
                        const label = labelFromCsv(file);
                        if (node.widgets.some(w => w.name === label)) continue;

                        const item = document.createElement("div");
                        item.textContent = label;
                        item.style.padding = "4px 12px";
                        item.style.cursor = "pointer";
                        item.onclick = async () => {
                            menu.remove(); node._csvMenu = null;
                            const text = await fetchCsvFile(file);
                            const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
                            const values = ["disabled", "🎲random", ...lines];
                            node._crea_dynamicValues[label] = { value: "disabled", weight: 1 };
                            addComboAndWeight(node, label, values, { value: "disabled", weight: 1 });
                        };
                        item.onmouseover = () => item.style.background = "#444";
                        item.onmouseout = () => item.style.background = "transparent";
                        menu.appendChild(item);
                    }

                    document.body.appendChild(menu);
                    node._csvMenu = menu;
                } catch (err) { alert("Error when try to find CSV files."); }
            }, { serialize: false });
            addBtn.label = "➕ Add a Category";

            // Reset All Weights
            node.addWidget("button", "↺ Reset All Weights", "", () => {
                for (const [k, v] of Object.entries(node._crea_dynamicValues || {})) {
                    if (v && typeof v === "object") v.weight = 1.00;
                }
                for (const w of node.widgets) if (w.name?.endsWith(": Weight")) w.value = 1.00;
                node._crea_updateCsvJson?.();
                node.widgets_changed = true;
                const sz = node.computeSize(); node.size[1] = sz[1];
                node.onResize?.(node.size); node.graph.setDirtyCanvas(true, true);
            }, { serialize: false });

            // Preview Prompt (modal)
            node.addWidget("button", "👁 Preview Prompt", "", () => {
                const parts = [];
                for (const [k, v] of Object.entries(node._crea_dynamicValues || {})) {
                    if (!v || v.value === "disabled") continue;
                    let w = Number(v.weight ?? 1);
                    if (!Number.isFinite(w)) w = 1;
                    w = Math.round(w * 100) / 100;
                    if (Object.is(w, -0)) w = 0;
                    parts.push(w === 1 ? v.value : `(${v.value}:${w.toFixed(2)})`);
                }
                const preview = parts.join(",") || "(empty)";

                const overlay = document.createElement("div");
                Object.assign(overlay.style, {
                    position: "fixed", inset: "0", background: "rgba(0,0,0,0.5)",
                    zIndex: 99999, display: "flex", alignItems: "center",
                    justifyContent: "center", backdropFilter: "blur(2px)"
                });

                const modal = document.createElement("div");
                Object.assign(modal.style, {
                    width: "min(900px, 90vw)", maxHeight: "80vh",
                    background: "#1f1f1f", color: "#eaeaea", border: "1px solid #444",
                    borderRadius: "8px", boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
                    display: "flex", flexDirection: "column", overflow: "hidden",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
                });

                const header = document.createElement("div");
                header.textContent = "Prompt Preview";
                Object.assign(header.style, {
                    padding: "10px 14px", borderBottom: "1px solid #333",
                    fontWeight: "600", letterSpacing: "0.3px", background: "#262626"
                });

                const area = document.createElement("textarea");
                area.readOnly = true;
                area.value = preview;
                Object.assign(area.style, {
                    flex: "1 1 auto", padding: "12px 14px", background: "#161616",
                    color: "#eaeaea", border: "none", outline: "none", resize: "vertical",
                    minHeight: "240px", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word"
                });

                const footer = document.createElement("div");
                Object.assign(footer.style, {
                    display: "flex", gap: "8px", justifyContent: "flex-end",
                    padding: "10px 14px", borderTop: "1px solid #333", background: "#262626"
                });

                const hint = document.createElement("div");
                hint.textContent = "Astuce: Ctrl/Cmd+C pour copier la sélection.";
                Object.assign(hint.style, { marginRight: "auto", opacity: 0.8, fontSize: "12px" });

                const copyBtn = document.createElement("button");
                copyBtn.textContent = "Copier";
                Object.assign(copyBtn.style, {
                    padding: "8px 14px", background: "#3a7afe", color: "white",
                    border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600"
                });
                copyBtn.onclick = async () => {
                    try {
                        area.select();
                        document.execCommand?.("copy");
                        await navigator.clipboard?.writeText(area.value);
                        copyBtn.textContent = "Copié ✓";
                        setTimeout(() => copyBtn.textContent = "Copier", 1200);
                    } catch {
                        copyBtn.textContent = "Échec copie";
                        setTimeout(() => copyBtn.textContent = "Copier", 1200);
                    }
                };

                const closeBtn = document.createElement("button");
                closeBtn.textContent = "Fermer";
                Object.assign(closeBtn.style, {
                    padding: "8px 14px", background: "#444", color: "white",
                    border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "600"
                });
                function closeModal() {
                    try { document.body.removeChild(overlay); } catch { }
                    document.removeEventListener("keydown", onEsc, true);
                    document.body.style.overflow = "";
                }
                const onEsc = (e) => { if (e.key === "Escape") closeModal(); };
                document.addEventListener("keydown", onEsc, true);
                overlay.addEventListener("mousedown", (ev) => { if (ev.target === overlay) closeModal(); });
                closeBtn.onclick = closeModal;

                footer.appendChild(hint);
                footer.appendChild(copyBtn);
                footer.appendChild(closeBtn);

                modal.appendChild(header);
                modal.appendChild(area);
                modal.appendChild(footer);
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
                document.body.style.overflow = "hidden";
                setTimeout(() => { area.focus(); area.select(); }, 0);
            }, { serialize: false });

            // Restore dynamic combos from __csv_json (if present)
            waitForJsonToBeReady(node);

            // Optionally load default combos if empty
            setTimeout(() => {
                const now = performance.now();
                const isRefresh = (now - window._crea_prompt_launch_time) < 3000;
                if (!isRefresh) tryLoadDefaultCombos(node);
            }, 500);
        };
    }
});

// ---------- Restore from __csv_json ----------
function waitForJsonToBeReady(node) {
    let attempts = 0;
    const check = async () => {
        const widget = node.widgets.find(w => w.name === "__csv_json");
        const raw = widget ? widget.value : null;

        if (!raw || typeof raw !== "string" || raw.trim() === "" || raw.trim() === "{}") {
            attempts++;
            if (attempts < 50) return setTimeout(check, 100);
            return;
        }

        try {
            const parsed = JSON.parse(raw);
            const fixed = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === "object" && v) fixed[k] = { value: String(v.value ?? "disabled"), weight: Number.isFinite(Number(v.weight)) ? Number(v.weight) : 1 };
                else fixed[k] = { value: String(v ?? "disabled"), weight: 1 };
            }
            node._crea_dynamicValues = fixed;

            const rawIsJson = typeof raw === "string" && raw.trim().startsWith("{") && raw.includes(":");
            if (rawIsJson && !node._crea_restored) {
                node._crea_restored = true;
                window.creaPromptRestores.push(node);
            }
        } catch (e) { console.warn("❌ JSON __csv_json mal formé ou vide :", raw); }
    };
    check();
}

let attempt = 0;
const waitAndRestore = async () => {
    attempt++;
    const nodes = window.creaPromptRestores || [];
    if (!nodes.length && attempt < 50) return setTimeout(waitAndRestore, 100);
    if (!nodes.length) return;

    window._crea_prompt_refresh_done = true;

    const allFiles = await fetchCsvList();
    const fileMap = {};
    for (const f of allFiles) fileMap[labelFromCsv(f)] = f;

    for (const node of nodes) {
        const dynamicValues = node._crea_dynamicValues || {};
        const updateCsvJson = node._crea_updateCsvJson;

        for (const [label, rec] of Object.entries(dynamicValues)) {
            if (node.widgets.some(w => w.name === label)) continue;

            const matchingFile = fileMap[label];
            if (!matchingFile) continue;

            const text = await fetchCsvFile(matchingFile);
            const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
            const values = ["disabled", "🎲random", ...lines];

            const initial = (typeof rec === "object" && rec)
                ? { value: String(rec.value ?? "disabled"), weight: Number.isFinite(Number(rec.weight)) ? Number(rec.weight) : 1 }
                : { value: String(rec ?? "disabled"), weight: 1 };

            addComboAndWeight(node, label, values, initial);
        }
        updateCsvJson?.();
    }
};
window._crea_prompt_refresh_done = true;
waitAndRestore();

// ---------- Default combos loader ----------
async function tryLoadDefaultCombos(node) {
    try {
        if (Object.keys(node._crea_dynamicValues || {}).length > 0) return;

        const res = await fetch(`${BASE}/presets/default_combos.txt`);
        if (!res.ok) return;

        const labelsText = await res.text();
        const labels = labelsText.split("\n").map(l => l.trim()).filter(Boolean);

        const allFiles = await fetchCsvList();
        const fileMap = {};
        for (const f of allFiles) fileMap[labelFromCsv(f)] = f;

        for (const label of labels) {
            if (node.widgets.some(w => w.name === label)) continue;

            const file = fileMap[label];
            if (!file) continue;

            const content = await fetchCsvFile(file);
            const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
            const values = ["disabled", "🎲random", ...lines];

            node._crea_dynamicValues[label] = { value: "disabled", weight: 1 };
            addComboAndWeight(node, label, values, { value: "disabled", weight: 1 });
        }

        node._crea_updateCsvJson?.();
        node.widgets_changed = true;
    } catch (e) {
        console.warn("⚠️ Erreur lors du chargement des combos par défaut :", e);
    }
}
