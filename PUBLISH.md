# Publishing hytale-name to npm

## Prerequisites

1. **Create an npm account** (if you don't have one):
   - Go to https://www.npmjs.com/signup
   - Create a free account

2. **Login to npm**:
   ```bash
   npm login
   ```
   Enter your username, password, and email when prompted.

## Check if package name is available

The package name `hytale-name` might already be taken. You can:
- Check manually at: https://www.npmjs.com/package/hytale-name
- Or try to publish - npm will tell you if it's taken

If the name is taken, update the `name` field in `package.json` to something unique like:
- `@yourusername/hytale-name` (scoped package)
- `hytale-name-checker`
- `hytale-username-checker`
- Or any other unique name

## Publishing Steps

1. **Navigate to the package directory**:
   ```bash
   cd hytale-name
   ```

2. **Optional: Test locally first**:
   ```bash
   npm link
   ```
   This creates a global symlink so you can test `hytale-name` command.

3. **Publish to npm**:
   ```bash
   npm publish
   ```
   
   For a scoped package (if you used `@username/hytale-name`):
   ```bash
   npm publish --access public
   ```

## After Publishing

Once published, users can install it globally:
```bash
npm install -g hytale-name
```

Or use it with npx:
```bash
npx hytale-name wordlist.txt
```

## Updating the Package

To publish updates:
1. Update the `version` in `package.json` (or use `npm version patch/minor/major`)
2. Run `npm publish` again

## Troubleshooting

- **401 Unauthorized**: Make sure you're logged in with `npm login`
- **Package name already taken**: Change the name in `package.json`
- **403 Forbidden**: You might need to verify your email on npmjs.com

