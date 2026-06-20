"""Create an appearance VARIANT of an avatar by recoloring its materials, in Blender.

Keeps the SAME rig + blendshapes (so body animation + ARKit lip-sync are identical)
and only tints hair / skin / outfit / eyes — a fast, fully in-house way to spin up
a roster of distinct photoreal anchors from one base (e.g. an Avaturn export).

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender --background --python \
        scripts/avatar-variant.py -- <base.glb> <out.glb> \
        [--hair R,G,B] [--skin R,G,B] [--outfit R,G,B] [--eyes R,G,B]

Colors are 0..1 linear multipliers applied over the existing textures (so detail
is preserved). Materials are matched by name keyword, which fits Avaturn/RPM
exports (hair*, look/outfit/cloth*, Head/Body/skin*, Eye*).
"""

import bpy
import sys


def _tint(mat, rgb):
    if not mat or not mat.use_nodes:
        return False
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        return False
    bc = bsdf.inputs["Base Color"]
    if not bc.is_linked:
        bc.default_value = (*rgb, 1.0)
        return True
    src = bc.links[0].from_socket
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    cols = [i for i in mix.inputs if i.type == "RGBA"]
    nt.links.new(src, cols[0])
    cols[1].default_value = (*rgb, 1.0)
    out = [o for o in mix.outputs if o.type == "RGBA"][0]
    nt.links.new(out, bc)
    return True


def _match(name, kind):
    n = name.lower()
    if kind == "hair":
        return "hair" in n
    if kind == "outfit":
        return any(k in n for k in ("look", "outfit", "cloth", "shirt", "suit", "top", "jacket"))
    if kind == "skin":
        return n in ("head", "body") or "skin" in n
    if kind == "eyes":
        return n.startswith("eye") and "lash" not in n and "eyeao" not in n
    return False


def variant(src, dst, tints):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=src)
    applied = {}
    for kind, rgb in tints.items():
        hit = [m.name for m in bpy.data.materials if _match(m.name, kind) and _tint(m, rgb)]
        applied[kind] = hit
    bpy.ops.object.select_all(action="SELECT")
    ico = bpy.data.objects.get("Icosphere")
    if ico:
        ico.select_set(False)
    bpy.ops.export_scene.gltf(
        filepath=dst, export_format="GLB", use_selection=True,
        export_morph=True, export_skins=True, export_animations=False,
    )
    print("VARIANT ->", dst, "| tinted:", applied)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print("usage: blender -b --python avatar-variant.py -- <base.glb> <out.glb> [--hair R,G,B] [--skin R,G,B] [--outfit R,G,B] [--eyes R,G,B]")
        sys.exit(1)
    src, dst = argv[0], argv[1]
    tints = {}
    for kind in ("hair", "skin", "outfit", "eyes"):
        if "--" + kind in argv:
            v = argv[argv.index("--" + kind) + 1]
            tints[kind] = tuple(float(x) for x in v.split(","))
    variant(src, dst, tints)
