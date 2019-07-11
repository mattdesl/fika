# fika

A figma plugin generator using [Parcel](https://parceljs.org/).

#### 1. Install

```sh
npm install @mattdesl/fika -g
```

#### 2. Create an Empty Folder

Create and move into an empty folder where you'd like to keep all your plugins:

```sh
mkdir figma-plugins
cd figma-plugins
```

#### 3. Generate a new Plugin

This will generate `./src/my-plugin` and start a development server.

```sh
fika my-plugin --init --name="Cool Plugin"
```

Other examples:

```sh
# a plugin without HTML
fika some-command --init --no-ui

# start developing an existing plugin
fika my-existing-plugin

# use a different root folder than ./src
fika lib/my-plugin
```

You can open [http://localhost:9966/](http://localhost:9966/) to test your UI, and edit the files inside `./src/my-plugin` to see them reload.

#### 4. Test Build in Figma

Open Figma, choose Add Plugin From File and select the built `./dist/my-plugin/manifest.json` (notice **dist** not **src**).

#### 5. Build for Production

Kill the server and run the following to build a smaller and more optimized production plugin:

```sh
fika my-plugin --build
```

This will generate assets into `./dist/my-plugin`.

## License

MIT, see [LICENSE.md](http://github.com/mattdesl/fika/blob/master/LICENSE.md) for details.
