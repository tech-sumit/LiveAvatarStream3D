"""Conform a humanoid GLB toward the platform's canonical rig, in Blender.

Run headless:
    /Applications/Blender.app/Contents/MacOS/Blender --background --python \
        scripts/conform-avatar.py -- <in.glb> <out.glb> [--no-tpose]

(Or paste the body of conform()/conform_tpose() into the live Blender-MCP session.)

What it does:
  1. Canonical bone names — strip the `mixamorig:` prefix (RPM convention).
  2. T-pose rest — rotate the upper-arm + forearm bones to horizontal (±X) and
     bake the pose as the new rest, so the ONE shared idle/talk clip set lines up.
  3. Re-export GLB (morphs + skin preserved).

HONEST LIMITATION: this fixes the rest *pose*, *names*, and scale baseline — which
is necessary for the shared clips to retarget. It does NOT re-roll bones. A rig
whose arm/forearm bone *roll* differs from the RPM clips (e.g. MakeHuman/MPFB)
will still twist the forearms/wrists under animation; such avatars are best left
`bodyAnim:false` (static). Avaturn / Avatar SDK / RPM rigs already match and
animate cleanly — for them this script only matters if they ship an A-pose.
"""

import bpy
import sys
import mathutils


def strip_mixamo_prefix(arm):
    for b in arm.data.bones:
        if b.name.lower().startswith("mixamorig:"):
            b.name = b.name.split(":", 1)[1]


def conform_tpose(arm):
    """Rotate arm + forearm bones to horizontal (±X) and bake as the rest pose."""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    mw = arm.matrix_world

    def point(name, tgt):
        pb = arm.pose.bones.get(name)
        if not pb:
            return
        head = (mw @ pb.matrix).translation
        y = mathutils.Vector(tgt).normalized()
        up = mathutils.Vector((0, 0, 1))
        if abs(y.dot(up)) > 0.99:
            up = mathutils.Vector((0, 1, 0))
        x = y.cross(up).normalized()
        z = x.cross(y).normalized()
        m = mathutils.Matrix((x, y, z)).transposed().to_4x4()
        m.translation = head
        pb.matrix = mw.inverted() @ m
        bpy.context.view_layer.update()

    for side, sx in (("Left", 1.0), ("Right", -1.0)):
        point(side + "Arm", (sx, 0, 0))
        point(side + "ForeArm", (sx, 0, 0))
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def conform(src, dst, do_tpose=True):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=src)
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if arm:
        strip_mixamo_prefix(arm)
        if do_tpose:
            conform_tpose(arm)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=dst, export_format="GLB", use_selection=True,
        export_morph=True, export_skins=True, export_animations=False,
    )
    print("CONFORMED ->", dst)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print("usage: blender -b --python conform-avatar.py -- <in.glb> <out.glb> [--no-tpose]")
        sys.exit(1)
    conform(argv[0], argv[1], do_tpose="--no-tpose" not in argv)
