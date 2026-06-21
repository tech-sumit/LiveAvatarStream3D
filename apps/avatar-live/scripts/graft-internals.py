"""Graft internal mouth anatomy (teeth + tongue) from Avaturn into a rigged
Hunyuan (or any single-shell) head, so the generated identity keeps its exact face
but the mouth opens onto real teeth.

Image-to-3D (Hunyuan3D) makes a hollow outer shell — sealed lips, no cavity, no
teeth/tongue/eyeballs. This adds the talking-critical internals while keeping the
generated geometry/texture. Run AFTER the model is rigged with a Head + Jaw bone
(see the auto-rig recipe: skeleton + Jaw bone for jaw-bone lip-sync).

Run in Blender (live via MCP, or headless):
    blender -b --python scripts/graft-internals.py -- <rigged.glb> <avaturn.glb> <out.glb>

What it does:
  1. Import the rigged target (armature with Head + Jaw bones + the shell mesh).
  2. Import Avaturn, pull out Teeth_Mesh + Tongue_Mesh.
  3. Auto-detect the target mouth from face landmarks (nose = max-Y in the head
     band; chin = lowest front-center point) and move the teeth/tongue behind the
     lips at that height.
  4. Skin the teeth to the Head bone (upper teeth read correctly) and the tongue to
     the Jaw bone (follows the mouth). Re-export.

Eyes are left as the generated texture (adding real eyeballs needs socket cutting;
the painted eyes read acceptably for an anchor).
"""

import bpy
import sys
from mathutils import Vector


def _head_landmarks(mesh):
    V = [mesh.matrix_world @ v.co for v in mesh.data.vertices]
    zmax = max(p.z for p in V)
    head = [p for p in V if p.z > zmax - 0.34]
    nose = max(head, key=lambda p: p.y)
    front = [p for p in head if abs(p.x) < 0.05 and p.y > 0.04]
    chin = min(front, key=lambda p: p.z)
    return nose, chin


def _center(o):
    co = o.data.shape_keys.key_blocks["Basis"].data if o.data.shape_keys else o.data.vertices
    vs = [o.matrix_world @ c.co for c in co]
    n = len(vs)
    return Vector((sum(p.x for p in vs) / n, sum(p.y for p in vs) / n, sum(p.z for p in vs) / n))


def graft(rigged, avaturn, out):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=rigged)
    ico = bpy.data.objects.get("Icosphere")
    if ico:
        bpy.data.objects.remove(ico, do_unlink=True)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    shell = next(o for o in bpy.data.objects if o.type == "MESH")
    nose, chin = _head_landmarks(shell)
    # mouth: between nose and chin, just behind the lip line
    mouth = Vector((0.0, chin.y - 0.07, (nose.z + chin.z) / 2 + 0.005))

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=avaturn)
    ico = bpy.data.objects.get("Icosphere")
    if ico:
        bpy.data.objects.remove(ico, do_unlink=True)
    teeth = tongue = None
    for o in [o for o in bpy.data.objects if o not in before]:
        base = o.name.split(".")[0]
        if o.type == "MESH" and base == "Teeth_Mesh":
            teeth = o
        elif o.type == "MESH" and base == "Tongue_Mesh":
            tongue = o
        else:
            bpy.data.objects.remove(o, do_unlink=True)

    def place(o, drop=0.0):
        c = _center(o)
        o.location += mouth - c + Vector((0, 0, drop))
        bpy.context.view_layer.update()

    def skin(o, bone):
        o.parent = arm
        o.matrix_parent_inverse = arm.matrix_world.inverted()
        for m in [m for m in o.modifiers if m.type == "ARMATURE"]:
            o.modifiers.remove(m)
        md = o.modifiers.new("arm", "ARMATURE")
        md.object = arm
        o.vertex_groups.clear()
        vg = o.vertex_groups.new(name=bone)
        vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")

    place(teeth)
    place(tongue, drop=-0.008)
    skin(teeth, "Head")     # teeth fixed to head (upper teeth read right)
    skin(tongue, "Jaw")     # tongue follows the jaw

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True,
                              export_skins=True, export_morph=False, export_animations=False)
    print("GRAFTED ->", out, "| mouth at", [round(c, 3) for c in mouth])


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 3:
        print("usage: blender -b --python graft-internals.py -- <rigged.glb> <avaturn.glb> <out.glb>")
        sys.exit(1)
    graft(argv[0], argv[1], argv[2])
