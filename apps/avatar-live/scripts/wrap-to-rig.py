"""EXPERIMENTAL: map a generated/foreign head onto Avaturn's RIGGED head, so the
result has the target's face shape but Avaturn's topology + skeleton + 73 ARKit
blendshapes (→ identical body animation + lip-sync). This is the "map a generated
3D asset onto Avaturn's skeleton" step of the image→3D→studio pipeline.

Run in Blender (live via MCP, or headless):
    blender -b --python scripts/wrap-to-rig.py -- <base_avaturn.glb> <target_head.glb|obj> <out.glb>

Method: align the target to Avaturn's head (bbox center + height), then for the
front-face region project each Basis vertex onto the nearest target-surface point
with a smooth falloff (no seams), preserving every shape-key delta. The head bone
isn't moved, so weights stay valid and the face animates.

QUALITY (be honest): this is nearest-point projection — fine for moderate identity
shifts, but a strong/foreign head needs LANDMARK-guided non-rigid fitting (eyes,
mouth interior, ears, nostrils otherwise pull to the surface). Treat the output as
a starting point; tune FACE_CTR / RADIUS / strength, and expect manual cleanup for
photo-accurate identity. (For production identity, Avaturn's own photo→avatar is
the clean path.)
"""

import bpy
import sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def _bounds(verts):
    mn = Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    mx = Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    return mn, mx, (mn + mx) / 2


def wrap(base_glb, target_file, out_glb, radius=0.13, max_strength=0.9):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=base_glb)
    ico = bpy.data.objects.get("Icosphere")
    if ico:
        bpy.data.objects.remove(ico, do_unlink=True)
    head = bpy.data.objects["Head_Mesh"]
    sk = head.data.shape_keys
    basis = sk.key_blocks["Basis"]
    base_old = [v.co.copy() for v in basis.data]
    hmn, hmx, hc = _bounds(base_old)
    head_h = hmx.z - hmn.z

    # import target (glb/obj), pick its largest mesh
    before = set(bpy.data.objects)
    if target_file.lower().endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=target_file)
    else:
        bpy.ops.import_scene.gltf(filepath=target_file)
    timeshes = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    tgt = max(timeshes, key=lambda o: len(o.data.vertices))
    tco = [tgt.matrix_world @ v.co for v in tgt.data.vertices]
    tmn, tmx, tcen = _bounds(tco)
    # align target to the head: scale to match head height, translate centroid
    s = head_h / max(1e-6, (tmx.z - tmn.z))
    tco_aligned = [(c - tcen) * s + hc for c in tco]
    faces = [tuple(p.vertices) for p in tgt.data.polygons]
    bvh = BVHTree.FromPolygons([tuple(c) for c in tco_aligned], faces, all_triangles=False)

    def strength(co):
        if co.y < hc.y - 0.02:      # front hemisphere only (skip back of skull)
            return 0.0
        d = (co - Vector((hc.x, hmx.y, hc.z + head_h * 0.05))).length
        return max(0.0, min(max_strength, max_strength * (1.0 - d / radius)))

    base_new = []
    for c in base_old:
        w = strength(c)
        if w <= 0:
            base_new.append(c); continue
        loc, *_ = bvh.find_nearest(c)
        base_new.append(c.lerp(loc, w) if loc else c)

    for kb in sk.key_blocks:
        if kb == basis:
            for i, v in enumerate(kb.data): v.co = base_new[i]
        else:
            for i, v in enumerate(kb.data): v.co = base_new[i] + (v.co - base_old[i])
    for i, v in enumerate(head.data.vertices): v.co = base_new[i]
    head.data.update()
    bpy.data.objects.remove(tgt, do_unlink=True)
    for o in timeshes:
        if o.name in bpy.data.objects: bpy.data.objects.remove(o, do_unlink=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=out_glb, export_format="GLB", use_selection=True,
                              export_morph=True, export_skins=True, export_animations=False)
    moved = sum(1 for i in range(len(base_old)) if (base_new[i] - base_old[i]).length > 1e-4)
    print(f"WRAPPED -> {out_glb} | moved {moved}/{len(base_old)} face verts")


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 3:
        print("usage: blender -b --python wrap-to-rig.py -- <base_avaturn.glb> <target_head.glb|obj> <out.glb>")
        sys.exit(1)
    wrap(argv[0], argv[1], argv[2])
