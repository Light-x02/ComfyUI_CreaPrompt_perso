import os
import json
import random
from aiohttp import web

# ComfyUI server
from server import PromptServer
app = PromptServer.instance.app

# Répertoires (propres à ce module)
SCRIPT_DIR = os.path.dirname(__file__)
CSV_FOLDER = os.path.join(SCRIPT_DIR, "csv")           # mêmes CSV que l’original (collection.txt inclus)
PRESET_FOLDER = os.path.join(SCRIPT_DIR, "presets_w")  # dossier presets dédié à ce node

# Assure l’existence des dossiers
os.makedirs(CSV_FOLDER, exist_ok=True)
os.makedirs(PRESET_FOLDER, exist_ok=True)

# ----- Endpoints dédiés (préfixe unique) --------------------------------------------------------
BASE = "/custom_nodes/creaprompt_weight"

async def csv_list(request):
    try:
        files = [f for f in os.listdir(CSV_FOLDER) if f.endswith(".csv")]
        files.sort()
        return web.json_response(files)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def csv_file(request):
    filename = request.match_info["filename"]
    path = os.path.join(CSV_FOLDER, filename)
    if not os.path.isfile(path):
        return web.Response(status=404, text="File not found.")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return web.Response(text=f.read())
    except Exception as e:
        return web.Response(status=500, text=f"Error reading file: {e}")

async def preset_file(request):
    filename = request.match_info["filename"]
    path = os.path.join(PRESET_FOLDER, filename)
    if not os.path.isfile(path):
        return web.Response(status=404, text="Preset file not found.")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return web.Response(text=f.read())
    except Exception as e:
        return web.Response(status=500, text=f"Error reading preset: {e}")

async def list_presets(request):
    try:
        files = [f for f in os.listdir(PRESET_FOLDER) if f.endswith(".txt")]
        files.sort()
        return web.json_response(files)
    except Exception as e:
        return web.Response(status=500, text=f"Erreur lecture presets : {e}")

async def save_preset(request):
    try:
        data = await request.json()
        name = (data.get("name") or "").strip()
        content = (data.get("content") or "").strip()
        if not name or len(name) < 2:
            return web.Response(status=400, text="Nom de preset invalide.")
        filename = os.path.join(PRESET_FOLDER, f"{name}.txt")
        with open(filename, "w", encoding="utf-8") as f:
            f.write(content)
        return web.Response(status=200, text="Preset saved.")
    except Exception as e:
        return web.Response(status=500, text=f"Erreur lors de la sauvegarde : {e}")

async def delete_preset(request):
    filename = request.match_info["filename"]
    path = os.path.join(PRESET_FOLDER, filename)
    if not os.path.isfile(path):
        return web.Response(status=404, text="Preset file not found.")
    try:
        os.remove(path)
        return web.Response(text="Preset deleted.")
    except Exception as e:
        return web.Response(status=500, text=f"Error deleting preset: {e}")

# Enregistrement des routes (préfixe unique)
try:
    app.router.add_get(f"{BASE}/csv_list", csv_list)
    app.router.add_get(f"{BASE}/csv/{{filename}}", csv_file)
    app.router.add_get(f"{BASE}/presets/{{filename}}", preset_file)
    app.router.add_get(f"{BASE}/presets_list", list_presets)
    app.router.add_post(f"{BASE}/save_preset", save_preset)
    app.router.add_delete(f"{BASE}/delete_preset/{{filename}}", delete_preset)
    print("✅ creaprompt_dynamic_weight: endpoints registered")
except Exception as e:
    # Si déjà enregistrées (reload), on évite de crasher
    print(f"ℹ️ creaprompt_dynamic_weight: routes already registered? {e}")

# ----- Helpers ----------------------------------------------------------------------------------

def getfilename(folder):
    """Retourne les noms ‘logiques’ sans le préfixe 3 chars et l’extension .csv (compat CreaPrompt)."""
    names = []
    for filename in os.listdir(folder):
        if filename.endswith(".csv"):
            names.append(filename[3:-4])  # conserve le comportement original
    return names

def select_random_line_from_collection():
    file_path = os.path.join(CSV_FOLDER, "collection.txt")
    if not os.path.isfile(file_path):
        return ""
    with open(file_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    return random.choice(lines).strip() if lines else ""

def select_random_line_from_csv_file(basename, folder):
    """Choisit une ligne aléatoire dans le CSV dont le 'basename' (après les 3 premiers chars) correspond."""
    for filename in os.listdir(folder):
        if filename.endswith(".csv") and filename[3:-4] == basename:
            path = os.path.join(folder, filename)
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            return random.choice(lines).strip() if lines else ""
    return ""

def _apply_weight(text: str, weight):
    """Applique (texte:poids) si poids != 0 et != 1 (format xx:1.25, 2 décimales)."""
    if not text or text == "disabled":
        return text
    try:
        w = float(weight)
    except (TypeError, ValueError):
        w = 1.0
    # clamp doux pour cohérence UI (si tu limites -10..10 côté JS)
    if w < -10.0: w = -10.0
    if w >  10.0: w =  10.0
    # poids neutres -> pas de parenthèses
    if w == 0 or w == 1:
        return text
    return f"({text}:{w:.2f})"

# ----- Node -------------------------------------------------------------------------------------

class CreaPrompt_0_weight:
    """
    CreaPrompt Dynamic node with weight
    - Lit __csv_json (string) construit côté UI (combo + weight optionnel)
    - Génère N prompts (Prompt_count), soit depuis `collection.txt`, soit en concat par catégories
    - Respecte l'ordre UI (ordre des clés dans __csv_json)
    - Applique les weight à chaque valeur (random inclus)
    """

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("prompt", "seed")
    FUNCTION = "create_prompt"
    CATEGORY = "CreaPrompt"

    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "__csv_json": ("STRING", {"multiline": True, "default": "{}", "input": False}),
            },
            "optional": {
                "Prompt_count": ("INT", {"default": 1, "min": 1, "max": 1000}),
                "CreaPrompt_Collection": (["disabled", "enabled"], {"default": "disabled"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 1125899906842624}),
            },
        }

    def create_prompt(self, **kwargs):
        seed = kwargs.get("seed", 0)
        prompts_count = int(kwargs.get("Prompt_count", 1))

        # JSON dynamique (ordre préservé = ordre UI)
        try:
            dynamic_values = json.loads(kwargs.get("__csv_json", "{}"))
        except Exception:
            dynamic_values = {}

        # 1) Mode collection
        if kwargs.get("CreaPrompt_Collection", "disabled") == "enabled":
            lines = []
            for _ in range(prompts_count):
                lines.append(select_random_line_from_collection())
            final_values = "\n".join([l for l in lines if l is not None]).strip()
            print(f"➡️CreaPrompt prompt: {final_values}")
            print(f"➡️CreaPrompt Seed: {seed}")
            return (final_values, seed)

        # 2) Mode catégories — ordre = ordre des clés de __csv_json (sinon fallback CSV)
        keys_order = list(dynamic_values.keys())
        if not keys_order:  # fallback legacy : ordre des fichiers CSV
            keys_order = getfilename(CSV_FOLDER)

        all_prompts = []

        for _ in range(prompts_count):
            parts = []
            for basename in keys_order:
                dv = dynamic_values.get(basename, "disabled")

                # dv peut être string (legacy) ou objet {value, weight}
                if isinstance(dv, dict):
                    choice = (dv.get("value") or "disabled").strip()
                    weight = dv.get("weight", 1)
                else:
                    choice = (dv or "disabled").strip()
                    weight = 1

                if not choice or choice == "disabled":
                    continue

                if choice == "🎲random":
                    picked = select_random_line_from_csv_file(basename, CSV_FOLDER)
                    if picked:
                        parts.append(_apply_weight(picked, weight))
                else:
                    parts.append(_apply_weight(choice, weight))

            # jointure dans l'ordre UI
            prompt = ",".join([p for p in parts if p and p != "disabled"])
            print(f"➡️CreaPrompt prompt: {prompt}")
            all_prompts.append(prompt)

        final_values = "\n".join(all_prompts).strip()
        print(f"➡️CreaPrompt Seed: {seed}")
        return (final_values, seed)


# ----- ComfyUI registry ------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "CreaPrompt_0_weight": CreaPrompt_0_weight,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CreaPrompt_0_weight": "CreaPrompt Dynamic node with weight",
}
