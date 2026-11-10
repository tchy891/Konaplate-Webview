"""Loads / saves config.json and resolves a request body for a target+version."""

import copy
import json
import os

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")


def deep_merge(base, override):
    """Return a copy of `base` with `override` merged in (dicts merge, everything else replaces)."""
    result = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def set_by_path(obj, path, value):
    """Set a value using a dotted path, e.g. 'addressInfo.zipCode'."""
    parts = path.split(".")
    cursor = obj
    for part in parts[:-1]:
        if not isinstance(cursor.get(part), dict):
            cursor[part] = {}
        cursor = cursor[part]
    cursor[parts[-1]] = value


def find_values(obj, keys):
    """Recursively collect the first value found for each key in `keys`."""
    found = {}

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                # a null is not a usable captured value - it would substitute as the text "None"
                if (key in keys and key not in found and value is not None
                        and not isinstance(value, (dict, list))):
                    found[key] = value
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(obj)
    return found


class ConfigStore:
    def __init__(self, path=CONFIG_PATH):
        self.path = path
        self.data = {}
        self.load()

    # ---------------------------------------------------------------- loading
    def load(self):
        with open(self.path, "r", encoding="utf-8") as handle:
            self.data = json.load(handle)
        return self.data

    def save(self):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(self.data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")

    # ---------------------------------------------------------------- lookups
    @property
    def defaults(self):
        return self.data.get("defaults", {})

    @property
    def random_fields(self):
        return self.data.get("randomFields", {})

    def target_keys(self):
        return list(self.data.get("targets", {}).keys())

    def target_label(self, target_key):
        return self.data["targets"][target_key].get("label", target_key)

    def label_to_target(self, label):
        for key in self.target_keys():
            if self.target_label(key) == label:
                return key
        return label

    def version_keys(self, target_key):
        return list(self.data["targets"][target_key].get("versions", {}).keys())

    def connection(self, target_key, version_key):
        """baseUrl / aspId / accessKey / endpoints for one affiliate + webview version."""
        return self.data["targets"][target_key]["versions"][version_key]

    def endpoint(self, target_key, version_key, feature_key):
        return self.connection(target_key, version_key).get("endpoints", {}).get(feature_key, "")

    def feature_keys(self):
        features = self.data.get("features", {})
        return sorted(features, key=lambda key: features[key].get("order", 99))

    def feature(self, feature_key):
        return self.data["features"][feature_key]

    # ---------------------------------------------------------------- bodies
    def resolved_body(self, feature_key, target_key, version_key):
        """Default body for the feature, deep-merged with the target+version override."""
        feature = self.feature(feature_key)
        override = feature.get("overrides", {}).get(target_key, {}).get(version_key, {})
        return deep_merge(feature.get("body", {}), override)

    def save_override(self, feature_key, target_key, version_key, body):
        """Store `body` as the override for this target+version, then persist config.json."""
        feature = self.feature(feature_key)
        feature.setdefault("overrides", {}).setdefault(target_key, {})[version_key] = body
        self.save()

    def save_default_body(self, feature_key, body):
        """Store `body` as the feature-wide default, then persist config.json."""
        self.feature(feature_key)["body"] = body
        self.save()
