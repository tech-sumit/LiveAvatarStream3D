"""Parametrically reshape an avatar's BODY/FACE while keeping its skeleton + ARKit
blendshapes working — a reliable, artifact-free way to make distinct people from
one rigged base (e.g. Avaturn).

Run in Blender (live via MCP, or headless):
    /Applications/Blender.app/Contents/MacOS/Blender --background --python \
        scripts/reshape-avatar.py -- <base.glb> <out.glb> \
        [--height 1.06] [--build 0.9] [--headSize 0.96] \
        [--faceWidth 0.9] [--faceLength 1.07] [--jaw 0.88]

How it stays riggable + lip-syncable:
  • topology is never changed (skin weights + shape-key correspondence intact);
  • the per-vertex transform is applied to the Basis AND re-added to every shape
    key's delta (expressions preserved exactly);
  • the SAME transform is applied to the armature's rest bones, so animation
    pivots match the new proportions (without this the limbs deform wrong).

Axes (Avaturn space): Z up (feet 0 → head ~1.85), Y forward(+), X lateral. Neck≈1.50.
"""

import bpy
import sys
from mathutils import Vector

NECK, CHIN = 1.50, 1.62


def make_xform(P):
    def xform(co):
        x, y, z = co.x, co.y, co.z
        if z > NECK:                                   # head: size + face shape
            dz = (z - NECK) * P["headSize"] * P["faceLength"]
            x *= P["headSize"] * P["faceWidth"]
            y *= P["headSize"]
            z = NECK + dz
        if NECK < z <= CHIN:                           # jaw width
            x *= P["jaw"]
        x *= P["build"]; y *= P["build"]               # body girth
        z *= P["height"]                               # stature
        return Vector((x, y, z))
    return xform


def reshape(src, dst, P):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=src)
    ico = bpy.data.objects.get("Icosphere")
    if ico:
        bpy.data.objects.remove(ico, do_unlink=True)
    xform = make_xform(P)

    # meshes: deform Basis + preserve every shape-key delta
    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        sk = o.data.shape_keys
        if sk:
            basis = sk.key_blocks["Basis"]
            old = [v.co.copy() for v in basis.data]
            new = [xform(c) for c in old]
            for kb in sk.key_blocks:
                if kb == basis:
                    for i, v in enumerate(kb.data): v.co = new[i]
                else:
                    for i, v in enumerate(kb.data): v.co = new[i] + (v.co - old[i])
            for i, v in enumerate(o.data.vertices): v.co = new[i]
        else:
            for v in o.data.vertices: v.co = xform(v.co)
        o.data.update()

    # armature: move rest bones by the same transform (world space)
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if arm:
        mw, mwi = arm.matrix_world, arm.matrix_world.inverted()
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode="EDIT")
        new = {b.name: (mwi @ xform(mw @ b.head), mwi @ xform(mw @ b.tail)) for b in arm.data.edit_bones}
        for b in arm.data.edit_bones:
            b.head, b.tail = new[b.name]
        bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", use_selection=True,
                              export_morph=True, export_skins=True, export_animations=False)
    print("RESHAPED ->", dst, "|", P)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print("usage: blender -b --python reshape-avatar.py -- <base.glb> <out.glb> [--height N] [--build N] [--headSize N] [--faceWidth N] [--faceLength N] [--jaw N]")
        sys.exit(1)
    P = dict(height=1.0, build=1.0, headSize=1.0, faceWidth=1.0, faceLength=1.0, jaw=1.0)
    for k in list(P):
        if "--" + k in argv:
            P[k] = float(argv[argv.index("--" + k) + 1])
    reshape(argv[0], argv[1], P)
