module.exports = {
  env: { node: true },
  extends: require.resolve("../.eslintrc"),
  parserOptions: {
    sourceType: "module"
  },
  rules: {
    "max-lines": "off",
    "security/detect-object-injection": "off"
  }
};
