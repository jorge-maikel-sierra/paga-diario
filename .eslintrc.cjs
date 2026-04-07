module.exports = {
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  extends: ['airbnb-base'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    // Permitir console para logging del servidor
    'no-console': 'off',

    // Permitir guiones bajos (convención de parciales EJS: _partial.ejs)
    'no-underscore-dangle': 'off',

    // Bloquear parseFloat y parseInt - usar Decimal.js para cálculos financieros
    'no-restricted-globals': [
      'error',
      {
        name: 'parseFloat',
        message: 'Prohibido: usa new Decimal() de decimal.js para valores numéricos/financieros.',
      },
      {
        name: 'parseInt',
        message: 'Prohibido: usa Number.parseInt() o new Decimal() según el caso.',
      },
    ],
    'no-restricted-properties': [
      'error',
      {
        object: 'Number',
        property: 'parseFloat',
        message: 'Prohibido: usa new Decimal() de decimal.js para valores numéricos/financieros.',
      },
      {
        object: 'global',
        property: 'parseFloat',
        message: 'Prohibido: usa new Decimal() de decimal.js para valores numéricos/financieros.',
      },
    ],

    // Forzar punto y coma (Airbnb style)
    semi: ['error', 'always'],

    // Forzar comillas simples
    quotes: ['error', 'single', { avoidEscape: true }],

    // --- Reglas de formato desactivadas (delegadas a Prettier) ---
    'operator-linebreak': 'off',
    'implicit-arrow-linebreak': 'off',
    indent: 'off',
    'object-curly-newline': 'off',
    'function-paren-newline': 'off',
    'newline-per-chained-call': 'off',

    // Permitir extensión .js en imports ESM
    'import/extensions': ['error', 'ignorePackages', {
      js: 'always',
      mjs: 'always',
    }],

    // Permitir named exports sin default
    'import/prefer-default-export': 'off',
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      rules: {
        'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      },
    },
    {
      files: ['prisma/seed.js'],
      rules: {
        'no-restricted-syntax': 'off',
        'no-await-in-loop': 'off',
        'no-unused-vars': ['error', { varsIgnorePattern: '^_' }],
        'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      },
    },
    {
      // import.controller.js usa createRequire para cargar multer v2 (módulo CJS)
      // El linter no puede resolver require() dinámicos, pero multer sí está en dependencies
      files: ['src/controllers/import.controller.js'],
      rules: {
        'import/no-extraneous-dependencies': 'off',
      },
    },
  ],
};
