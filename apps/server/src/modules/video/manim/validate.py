"""Static gate for model-generated Manim scenes (PLAN.md §6, Layer 1).

Reads a Python module on stdin, prints a JSON verdict on stdout:

    {"ok": true,  "errors": []}
    {"ok": false, "errors": ["line 12: import of 'os' is not allowed", ...]}

This runs BEFORE the scene is ever executed, and it is an ALLOWLIST: every
node type, every import and every called name must be explicitly permitted.
A blacklist of scary words is not a boundary — `getattr(o, "__cl" + "ass__")`
defeats one in a single line — so anything not named here is rejected on
sight, and the failure mode of an unfamiliar construct is a rejected scene
(which degrades to SVG, PLAN.md §8) rather than an executed one.

This is one of three layers. It cannot stop a determined adversary on its own;
it stops the realistic failure, which is our own model hallucinating
`os.system(...)` or `open(...)` inside an otherwise ordinary animation. Layers
2 (process isolation, scrubbed env, rlimits) and 3 (output validation) sit
behind it in render.service.ts.
"""

from __future__ import annotations

import ast
import json
import sys

# ── What may be imported ────────────────────────────────────────────────────
# manim itself, plus the numeric/stdlib helpers a scene legitimately needs to
# compute positions. Nothing here can touch the filesystem, the network, the
# process table or the environment.
ALLOWED_MODULES = frozenset({"manim", "numpy", "math", "random", "itertools", "functools"})

# ── Builtins that are escape hatches, not animation tools ───────────────────
# `getattr`/`setattr`/`vars` are here because they turn an attribute name into
# a runtime string, which is precisely how a dunder filter gets bypassed.
BANNED_NAMES = frozenset(
    {
        "eval", "exec", "compile", "open", "input", "__import__", "globals", "locals",
        "vars", "getattr", "setattr", "delattr", "hasattr", "breakpoint", "exit", "quit",
        "memoryview", "help", "dir", "id", "object", "type", "super", "classmethod",
        "staticmethod", "property",
    }
)

# Mobjects that read a file from disk. Banned for two reasons at once: they are
# a file-access vector the import allowlist does not cover (the path goes to
# manim, not to `open`), and there is no asset directory for them to succeed
# against anyway — a generated scene using one fails at render time with a
# confusing "raster image not found" deep inside manim. Observed in real
# output, which is why it is here rather than left to the prompt.
FILE_LOADING_MOBJECTS = frozenset(
    {"ImageMobject", "SVGMobject", "ImageMobjectFromCamera", "OpenGLImageMobject"}
)

# Manim APIs that were REMOVED or RENAMED, mapped to what replaces them.
#
# Models are trained on a lot of Manim from before 0.18, and they reach for the
# old names confidently. A removed *method* is the nastier half: it falls
# through to `Mobject.__getattr__`, which hands back a generic getter, and the
# call then dies with `getter() got an unexpected keyword argument 'x_range'` —
# a message that names neither the method nor the real problem, and that a
# retry cannot act on. Naming the replacement here turns the commonest failure
# in real output into a one-line, self-repairing rejection.
RENAMED_APIS = {
    "get_graph": "plot",
    "get_line_graph": "plot_line_graph",
    "ShowCreation": "Create",
    "FadeInFrom": "FadeIn(..., shift=...)",
    "FadeOutAndShift": "FadeOut(..., shift=...)",
    "TextMobject": 'Text("...", font="Noto Sans Bengali")',
    "TexMobject": "MathTex",
    "GraphScene": "Scene with an Axes mobject",
}

# Decorators a scene may legitimately carry. Anything else is a way to run code
# at class-definition time, which is before any of our own checks would matter.
ALLOWED_DECORATORS = frozenset({"staticmethod", "property"})

# ── Node types permitted anywhere in the module ─────────────────────────────
# Deny-by-default. Async and generator machinery is absent deliberately: a
# Scene.construct has no use for it, so its presence means the model is doing
# something we did not ask for.
ALLOWED_NODES = frozenset(
    {
        # structure
        ast.Module, ast.ClassDef, ast.FunctionDef, ast.Lambda, ast.arguments, ast.arg,
        ast.Return, ast.Pass, ast.Expr,
        # binding
        ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Delete, ast.Name, ast.Store,
        ast.Load, ast.Del, ast.Starred, ast.keyword,
        # control flow
        ast.If, ast.IfExp, ast.For, ast.While, ast.Break, ast.Continue,
        ast.With, ast.withitem, ast.Try, ast.ExceptHandler, ast.Raise, ast.Assert,
        # data
        ast.List, ast.Tuple, ast.Dict, ast.Set, ast.Subscript, ast.Slice,
        ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp, ast.comprehension,
        # expressions
        ast.Call, ast.Attribute, ast.Constant, ast.BinOp, ast.UnaryOp, ast.BoolOp,
        ast.Compare, ast.JoinedStr, ast.FormattedValue,
        # operators
        ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
        ast.LShift, ast.RShift, ast.BitOr, ast.BitXor, ast.BitAnd, ast.MatMult,
        ast.UAdd, ast.USub, ast.Not, ast.Invert, ast.And, ast.Or,
        ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
        ast.Is, ast.IsNot, ast.In, ast.NotIn,
        # imports (contents checked separately)
        ast.Import, ast.ImportFrom, ast.alias,
    }
)

# Bengali block. Bangla inside MathTex/Tex is a render-time LaTeX failure
# minutes later, not a syntax error now — manim's LaTeX template is pdflatex +
# inputenc with no Bengali support (PLAN.md §5.1). Catching it here is the
# difference between a rejected scene and a two-minute timeout in a subprocess.
BANGLA_START, BANGLA_END = 0x0980, 0x09FF
LATEX_CALLS = frozenset({"MathTex", "Tex", "SingleStringMathTex"})

REQUIRED_CLASS_NAME = "LessonScene"

# Names Python itself provides, which a scene may use without defining.
PYTHON_BUILTINS = frozenset(
    {
        "abs", "all", "any", "bool", "dict", "enumerate", "filter", "float", "format", "int",
        "len", "list", "map", "max", "min", "print", "range", "reversed", "round", "set",
        "slice", "sorted", "str", "sum", "tuple", "zip", "True", "False", "None",
        "Exception", "ValueError", "TypeError", "IndexError", "KeyError", "ZeroDivisionError",
        "AttributeError", "RuntimeError",
    }
)

# Injected by runner.py into the module namespace before the scene executes.
INJECTED_NAMES = frozenset({"SCENE_DURATION"})


def has_bangla(text: str) -> bool:
    return any(BANGLA_START <= ord(ch) <= BANGLA_END for ch in text)


def called_name(node: ast.Call) -> str:
    """Best-effort name of what is being called, for the LaTeX check."""
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def manim_namespace() -> frozenset[str] | None:
    """Everything `from manim import *` actually provides.

    Used to catch INVENTED identifiers — the model writes `BROWN_D`, which does
    not exist (manim has `DARK_BROWN` and `GREY_BROWN`), and the scene dies with
    a NameError two seconds into a render that had already been queued. Checking
    statically turns that into an instant, precise rejection and saves the render
    slot entirely.

    Returns None when manim cannot be imported, and the check is then SKIPPED
    rather than failing everything: this module's security rules must keep
    working against a broken venv, and an unknown-name check is a quality gate,
    not a safety one.
    """
    try:
        import manim  # noqa: PLC0415 — deliberately lazy; see the docstring
    except BaseException:
        return None
    exported = getattr(manim, "__all__", None) or dir(manim)
    return frozenset(exported)


class Validator(ast.NodeVisitor):
    def __init__(self, known_names: frozenset[str] | None) -> None:
        self.errors: list[str] = []
        self.scene_classes: list[str] = []
        self.known_names = known_names
        # Every name the module binds anywhere — assignments, function and class
        # definitions, parameters, comprehension and loop targets, except-as.
        # Collected across the WHOLE module rather than per-scope: real scope
        # analysis is a lot of machinery for a check whose only job is to catch
        # a hallucinated constant, and being generous here only risks missing a
        # bad name, never rejecting a good one.
        self.bound: set[str] = set()
        self.used: list[tuple[str, int]] = []

    def fail(self, node: ast.AST, message: str) -> None:
        line = getattr(node, "lineno", 0)
        self.errors.append(f"line {line}: {message}")

    # -- the deny-by-default sweep ------------------------------------------
    def generic_visit(self, node: ast.AST) -> None:
        if type(node) not in ALLOWED_NODES:
            self.fail(node, f"{type(node).__name__} is not allowed in a scene")
            return
        super().generic_visit(node)

    # -- imports -------------------------------------------------------------
    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root not in ALLOWED_MODULES:
                self.fail(node, f"import of '{alias.name}' is not allowed")
            self.bound.add(alias.asname or root)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        # A relative import has no module name to check and no legitimate use
        # here — there is nothing beside the scene file to import from.
        if node.level and node.level > 0:
            self.fail(node, "relative imports are not allowed")
        root = (node.module or "").split(".")[0]
        if root not in ALLOWED_MODULES:
            self.fail(node, f"import from '{node.module}' is not allowed")
        for alias in node.names:
            # `from manim import *` binds the whole namespace, which
            # `known_names` already covers.
            if alias.name != "*":
                self.bound.add(alias.asname or alias.name)
        self.generic_visit(node)

    # -- names and attributes ------------------------------------------------
    def visit_Name(self, node: ast.Name) -> None:
        # The single most important rule in this file. Blocking every dunder is
        # what closes `().__class__.__subclasses__()` and the whole family of
        # attribute-walking escapes, without having to enumerate them.
        if node.id.startswith("__"):
            self.fail(node, f"dunder identifier '{node.id}' is not allowed")
        elif node.id in BANNED_NAMES:
            self.fail(node, f"'{node.id}' is not allowed")

        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.bound.add(node.id)
        else:
            self.used.append((node.id, getattr(node, "lineno", 0)))

        self.generic_visit(node)

    def visit_arg(self, node: ast.arg) -> None:
        self.bound.add(node.arg)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.name:
            self.bound.add(node.name)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr.startswith("__"):
            self.fail(node, f"dunder attribute '.{node.attr}' is not allowed")
        self.generic_visit(node)

    # -- calls ---------------------------------------------------------------
    def visit_Call(self, node: ast.Call) -> None:
        name = called_name(node)

        if name in RENAMED_APIS:
            self.fail(node, f"`{name}` was removed in this version of manim — use `{RENAMED_APIS[name]}` instead")

        if name in FILE_LOADING_MOBJECTS:
            self.fail(
                node,
                f"{name} loads a file from disk, which is not available here — "
                "draw the picture with shapes (Circle, Rectangle, Polygon, Line, Arrow) instead",
            )

        if name in LATEX_CALLS:
            for arg in node.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and has_bangla(arg.value):
                    self.fail(
                        node,
                        "Bangla text inside MathTex/Tex — LaTeX cannot typeset Bengali. "
                        'Use Text("...", font="Noto Sans Bengali") for Bangla and keep '
                        "MathTex for equations and numerals only",
                    )
                # An f-string here is worse, not better: it hides the Bangla
                # until render time and is unnecessary for a LaTeX fragment.
                if isinstance(arg, ast.JoinedStr):
                    for value in arg.values:
                        if (
                            isinstance(value, ast.Constant)
                            and isinstance(value.value, str)
                            and has_bangla(value.value)
                        ):
                            self.fail(node, "Bangla text inside an f-string passed to MathTex/Tex")
        self.generic_visit(node)

    # -- the scene class -----------------------------------------------------
    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.bound.add(node.name)
        for decorator in node.decorator_list:
            name = decorator.id if isinstance(decorator, ast.Name) else ""
            if name not in ALLOWED_DECORATORS:
                self.fail(node, "class decorators are not allowed")

        bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
        if any(base.endswith("Scene") for base in bases):
            self.scene_classes.append(node.name)

        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.bound.add(node.name)
        for decorator in node.decorator_list:
            name = decorator.id if isinstance(decorator, ast.Name) else ""
            if name not in ALLOWED_DECORATORS:
                self.fail(node, f"decorator on '{node.name}' is not allowed")
        self.generic_visit(node)


def validate(source: str) -> dict[str, object]:
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return {"ok": False, "errors": [f"line {exc.lineno or 0}: syntax error: {exc.msg}"]}

    validator = Validator(manim_namespace())
    validator.visit(tree)
    errors = validator.errors

    if validator.known_names is not None:
        reported: set[str] = set()
        for name, line in validator.used:
            if name in validator.bound or name in validator.known_names:
                continue
            if name in PYTHON_BUILTINS or name in INJECTED_NAMES or name in reported:
                continue
            reported.add(name)
            errors.append(
                f"line {line}: '{name}' does not exist in manim — it looks invented. "
                "Use a real constant or define it yourself"
            )

    # The runner renders this class by name, so its absence is a hard failure
    # rather than something to discover as an empty output file later.
    if REQUIRED_CLASS_NAME not in validator.scene_classes:
        errors.append(
            f"line 0: no `class {REQUIRED_CLASS_NAME}(Scene)` found "
            f"(saw: {', '.join(validator.scene_classes) or 'none'})"
        )
    elif len(validator.scene_classes) > 1:
        errors.append(
            f"line 0: expected exactly one Scene class, found {len(validator.scene_classes)}: "
            + ", ".join(validator.scene_classes)
        )

    # Cap the report: a wholly malformed file can otherwise produce hundreds of
    # errors, and the first few are what gets fed back to the retry (§8).
    return {"ok": not errors, "errors": errors[:20]}


def main() -> None:
    source = sys.stdin.read()
    json.dump(validate(source), sys.stdout)


if __name__ == "__main__":
    main()
