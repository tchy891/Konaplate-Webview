"""Random value generation for request fields (CI, loginId, email, ...)."""

import random
import string
import uuid

from .config_store import set_by_path

CHARSETS = {
    "alphanumeric": string.ascii_letters + string.digits,
    "lower_alphanumeric": string.ascii_lowercase + string.digits,
    "upper_alphanumeric": string.ascii_uppercase + string.digits,
    "letters": string.ascii_letters,
    "digits": string.digits,
}

_rng = random.SystemRandom()


def random_string(length, charset="alphanumeric"):
    pool = CHARSETS.get(charset, CHARSETS["alphanumeric"])
    return "".join(_rng.choice(pool) for _ in range(max(0, length)))


def generate_value(spec):
    """Build one random value from a `randomFields` spec."""
    kind = (spec or {}).get("type", "token")

    if kind == "token":
        # Total length is preserved: prefix + random tail == spec["length"].
        total = int(spec.get("length", 32))
        prefix = str(spec.get("prefix", ""))[:total]
        return prefix + random_string(total - len(prefix), spec.get("charset", "alphanumeric"))

    if kind == "email":
        local = random_string(int(spec.get("localLength", 8)), spec.get("charset", "lower_alphanumeric"))
        return "{0}{1}@{2}".format(spec.get("prefix", ""), local, spec.get("domain", "yahoo.com"))

    if kind == "mobile":
        return str(spec.get("prefix", "010")) + random_string(int(spec.get("digits", 8)), "digits")

    if kind == "digits":
        return random_string(int(spec.get("length", 6)), "digits")

    if kind == "uuid":
        return str(uuid.uuid4())

    if kind == "fixed":
        return spec.get("value", "")

    raise ValueError("Unknown random field type: {0}".format(kind))


def apply_random_fields(body, field_names, specs):
    """Overwrite the listed fields in `body` with fresh random values.

    `field_names` entries may be dotted paths (e.g. 'addressInfo.zipCode') as long as
    a matching spec exists in config.json -> randomFields.
    Returns a dict of {field_name: generated_value}.
    """
    generated = {}
    for name in field_names or []:
        spec = specs.get(name)
        if spec is None:
            continue
        value = generate_value(spec)
        set_by_path(body, name, value)
        generated[name] = value
    return generated
