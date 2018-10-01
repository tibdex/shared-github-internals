module.exports = {
  env: { node: true },
  extends: require.resolve("../.eslintrc"),
  rules: {
    "max-lines": "off",
    "security/detect-non-literal-fs-filename": "off",
    "security/detect-object-injection": "off",
  },
};
