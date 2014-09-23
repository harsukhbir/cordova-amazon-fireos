#!/usr/bin/env node

/*
       Licensed to the Apache Software Foundation (ASF) under one
       or more contributor license agreements.  See the NOTICE file
       distributed with this work for additional information
       regarding copyright ownership.  The ASF licenses this file
       to you under the Apache License, Version 2.0 (the
       "License"); you may not use this file except in compliance
       with the License.  You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

       Unless required by applicable law or agreed to in writing,
       software distributed under the License is distributed on an
       "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
       KIND, either express or implied.  See the License for the
       specific language governing permissions and limitations
       under the License.
*/

var shell   = require('shelljs'),
    spawn   = require('./spawn'),
    Q       = require('q'),
    path    = require('path'),
    fs      = require('fs'),
    ROOT    = path.join(__dirname, '..', '..');
var check_reqs = require('./check_reqs');
var exec  = require('./exec');

var LOCAL_PROPERTIES_TEMPLATE =
    '# This file is automatically generated.\n' +
    '# Do not modify this file -- YOUR CHANGES WILL BE ERASED!\n';

function findApks(directory) {
    var ret = [];
    if (fs.existsSync(directory)) {
        fs.readdirSync(directory).forEach(function(p) {
            if (path.extname(p) == '.apk') {
                ret.push(path.join(directory, p));
            }
        });
    }
    return ret;
}

function sortFilesByDate(files) {
    return files.map(function(p) {
        return { p: p, t: fs.statSync(p).mtime };
    }).sort(function(a, b) {
        var timeDiff = b.t - a.t;
        return timeDiff === 0 ? a.p.length - b.p.length : timeDiff;
    }).map(function(p) { return p.p; });
}

function findOutputApksHelper(dir, build_type) {
    var ret = findApks(dir).filter(function(candidate) {
        // Need to choose between release and debug .apk.
        if (build_type === 'debug') {
            return /-debug/.exec(candidate) && !/-unaligned|-unsigned/.exec(candidate);
        }
        if (build_type === 'release') {
            return /-release/.exec(candidate) && !/-unaligned/.exec(candidate);
        }
        return true;
    });
    ret = sortFilesByDate(ret);
    if (ret.length === 0) {
        return ret;
    }
    var archSpecific = !!/-x86|-arm/.exec(ret[0]);
    return ret.filter(function(p) {
        return !!/-x86|-arm/.exec(p) == archSpecific;
    });
}

function hasCustomRules() {
    return fs.existsSync(path.join(ROOT, 'custom_rules.xml'));
}

function extractProjectNameFromManifest(projectPath) {
    var manifestPath = path.join(projectPath, 'AndroidManifest.xml');
    var manifestData = fs.readFileSync(manifestPath, 'utf8');
    var m = /<activity[\s\S]*?android:name\s*=\s*"(.*?)"/i.exec(manifestData);
    if (!m) {
        throw new Error('Could not find activity name in ' + manifestPath);
    }
    return m[1];
}

function extractSubProjectPaths() {
    var data = fs.readFileSync(path.join(ROOT, 'project.properties'), 'utf8');
    var ret = {};
    var r = /^\s*android\.library\.reference\.\d+=(.*)(?:\s|$)/mg
    var m;
    while (m = r.exec(data)) {
        ret[m[1]] = 1;
    }
    return Object.keys(ret);
}

var builders = {
    ant: {
        getArgs: function(cmd) {
            var args = [cmd, '-f', path.join(ROOT, 'build.xml')];
            // custom_rules.xml is required for incremental builds.
            if (hasCustomRules()) {
                args.push('-Dout.dir=ant-build', '-Dgen.absolute.dir=ant-gen');
            }
            return args;
        },

        prepEnv: function() {
            return check_reqs.check_ant()
            .then(function() {
                // Copy in build.xml on each build so that:
                // A) we don't require the Android SDK at project creation time, and
                // B) we always use the SDK's latest version of it.
                var sdkDir = process.env['ANDROID_HOME'];
                var buildTemplate = fs.readFileSync(path.join(sdkDir, 'tools', 'lib', 'build.template'), 'utf8');
                function writeBuildXml(projectPath) {
                    var newData = buildTemplate.replace('PROJECT_NAME', extractProjectNameFromManifest(ROOT));
                    fs.writeFileSync(path.join(projectPath, 'build.xml'), newData);
                    if (!fs.existsSync(path.join(projectPath, 'local.properties'))) {
                        fs.writeFileSync(path.join(projectPath, 'local.properties'), LOCAL_PROPERTIES_TEMPLATE);
                    }
                }
                var subProjects = extractSubProjectPaths();
                writeBuildXml(ROOT);
                for (var i = 0; i < subProjects.length; ++i) {
                    writeBuildXml(path.join(ROOT, subProjects[i]));
                }
            });
        },

        /*
         * Builds the project with ant.
         * Returns a promise.
         */
        build: function(build_type) {
            // Without our custom_rules.xml, we need to clean before building.
            var ret = Q();
            if (!hasCustomRules()) {
                // clean will call check_ant() for us.
                ret = this.clean();
            }

            var builder = this;
            var args = this.getArgs(build_type == 'debug' ? 'debug' : 'release');
            return check_reqs.check_ant()
            .then(function() {
                return spawn('ant', args);
            });
        },

        clean: function() {
            var args = this.getArgs('clean');
            return check_reqs.check_ant()
            .then(function() {
                return spawn('ant', args);
            });
        },

        findOutputApks: function(build_type) {
            var binDir = path.join(ROOT, hasCustomRules() ? 'ant-build' : 'bin');
            return findOutputApksHelper(binDir, build_type);
        }
    },
    gradle: {
        getArgs: function(cmd) {
            var lintSteps;
            if (process.env['BUILD_MULTIPLE_APKS']) {
                lintSteps = [
                    'lint',
                    'lintVitalX86Release',
                    'lintVitalArmv7Release',
                    'compileLint',
                    'copyReleaseLint',
                    'copyDebugLint'
                ];
            } else {
                lintSteps = [
                    'lint',
                    'lintVitalRelease',
                    'compileLint',
                    'copyReleaseLint',
                    'copyDebugLint'
                ];
            }
            if (cmd == 'debug') {
                cmd = 'assembleDebug';
            } else if (cmd == 'release') {
                cmd = 'assembleRelease';
            }
            var args = [cmd, '-b', path.join(ROOT, 'build.gradle')];
            // 10 seconds -> 6 seconds
            args.push('-Dorg.gradle.daemon=true');
            // Excluding lint: 6s-> 1.6s
            for (var i = 0; i < lintSteps.length; ++i) {
                args.push('-x', lintSteps[i]);
            }
            // Shaves another 100ms, but produces a "try at own risk" warning. Not worth it (yet):
            // args.push('-Dorg.gradle.parallel=true');
            return args;
        },

        prepEnv: function() {
            return check_reqs.check_gradle()
            .then(function() {
                // Copy the gradle wrapper on each build so that:
                // A) we don't require the Android SDK at project creation time, and
                // B) we always use the SDK's latest version of it.
                var projectPath = ROOT;
                // check_reqs ensures that this is set.
                var sdkDir = process.env['ANDROID_HOME'];
                var wrapperDir = path.join(sdkDir, 'tools', 'templates', 'gradle', 'wrapper');
                if (process.platform == 'win32') {
                    shell.cp('-f', path.join(wrapperDir, 'gradlew.bat'), projectPath);
                } else {
                    shell.cp('-f', path.join(wrapperDir, 'gradlew'), projectPath);
                }
                shell.rm('-rf', path.join(projectPath, 'gradle', 'wrapper'));
                shell.mkdir('-p', path.join(projectPath, 'gradle'));
                shell.cp('-r', path.join(wrapperDir, 'gradle', 'wrapper'), path.join(projectPath, 'gradle'));

                // Update the version of build.gradle in each dependent library.
                var pluginBuildGradle = path.join(projectPath, 'cordova', 'lib', 'plugin-build.gradle');
                var subProjects = extractSubProjectPaths();
                for (var i = 0; i < subProjects.length; ++i) {
                    shell.cp('-f', pluginBuildGradle, path.join(ROOT, subProjects[i], 'build.gradle'));
                }
            });
        },

        /*
         * Builds the project with gradle.
         * Returns a promise.
         */
        build: function(build_type) {
            var builder = this;
            var wrapper = path.join(ROOT, 'gradlew');
            var args = this.getArgs(build_type == 'debug' ? 'debug' : 'release');
            return Q().then(function() {
                return spawn(wrapper, args);
            });
        },

        clean: function() {
            var builder = this;
            var wrapper = path.join(ROOT, 'gradlew');
            var args = builder.getArgs('clean');
            return Q().then(function() {
                return spawn(wrapper, args);
            });
        },

        findOutputApks: function(build_type) {
            var binDir = path.join(ROOT, 'build', 'outputs', 'apk');
            return findOutputApksHelper(binDir, build_type);
        }
    },

    none: {
        prepEnv: function() {
            return Q();
        },
        build: function() {
            console.log('Skipping build...');
            return Q(null);
        },
        clean: function() {
            return Q();
        },
        findOutputApks: function(build_type) {
            return sortFilesByDate(builders.ant.findOutputApks(build_type).concat(builders.gradle.findOutputApks(build_type)));
        }
    }
};

function parseOpts(options) {
    // Backwards-compatibility: Allow a single string argument
    if (typeof options == "string") options = [options];

    var ret = {
        buildType: 'debug',
        buildMethod: process.env['ANDROID_BUILD'] || 'ant'
    };

    // Iterate through command line options
    for (var i=0; options && (i < options.length); ++i) {
        if (/^--/.exec(options[i])) {
            var option = options[i].substring(2);
            switch(option) {
                case 'debug':
                case 'release':
                    ret.buildType = option;
                    break;
                case 'ant':
                case 'gradle':
                    ret.buildMethod = option;
                    break;
                case 'nobuild' :
                    ret.buildMethod = 'none';
                    break;
                default :
                    return Q.reject('Build option \'' + options[i] + '\' not recognized.');
            }
        } else {
            return Q.reject('Build option \'' + options[i] + '\' not recognized.');
        }
    }
    return ret;
}

/*
 * Builds the project with the specifed options
 * Returns a promise.
 */
module.exports.runClean = function(options) {
    var opts = parseOpts(options);
    var builder = builders[opts.buildMethod];
    return builder.prepEnv()
    .then(function() {
        return builder.clean();
    }).then(function() {
        shell.rm('-rf', path.join(ROOT, 'out'));
    });
};

/*
 * Builds the project with the specifed options
 * Returns a promise.
 */
module.exports.run = function(options) {
    var opts = parseOpts(options);

    var builder = builders[opts.buildMethod];
    return builder.prepEnv()
    .then(function() {
        return builder.build(opts.buildType);
    }).then(function() {
        var apkPaths = builder.findOutputApks(opts.buildType);
        console.log('Built the following apk(s):');
        console.log('    ' + apkPaths.join('\n    '));
        return {
            apkPaths: apkPaths,
            buildType: opts.buildType,
            buildMethod: opts.buildMethod
        };
    });
};

/*
 * Detects the architecture of a device/emulator
 * Returns "arm" or "x86".
 */
module.exports.detectArchitecture = function(target) {
    return exec('adb -s ' + target + ' shell cat /proc/cpuinfo')
    .then(function(output) {
        if (/intel/i.exec(output)) {
            return 'x86';
        }
        return 'arm';
    });
};

module.exports.findBestApkForArchitecture = function(buildResults, arch) {
    var paths = buildResults.apkPaths.filter(function(p) {
        if (buildResults.buildType == 'debug') {
            return /-debug/.exec(p);
        }
        return !/-debug/.exec(p);
    });
    var archPattern = new RegExp('-' + arch);
    var hasArchPattern = /-x86|-arm/;
    for (var i = 0; i < paths.length; ++i) {
        if (hasArchPattern.exec(paths[i])) {
            if (archPattern.exec(paths[i])) {
                return paths[i];
            }
        } else {
            return paths[i];
        }
    }
    throw new Error('Could not find apk architecture: ' + arch + ' build-type: ' + buildResults.buildType);
};

module.exports.help = function() {
    console.log('Usage: ' + path.relative(process.cwd(), path.join(ROOT, 'cordova', 'build')) + ' [build_type]');
    console.log('Build Types : ');
    console.log('    \'--debug\': Default build, will build project in debug mode');
    console.log('    \'--release\': will build project for release');
    console.log('    \'--ant\': Default build, will build project with ant');
    console.log('    \'--gradle\': will build project with gradle');
    console.log('    \'--nobuild\': will skip build process (can be used with run command)');
    process.exit(0);
};
