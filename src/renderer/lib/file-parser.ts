import { UserConfiguration, ParsedUserConfiguration, ParsedData, ParsedUserConfigurationFile, ParsedDataWithFuzzy, userAccountData, ParserVariableData, AllVariables } from '../models';
import { getAvailableLogins } from "./steam-id-helpers";
import { FuzzyService } from "./../services";
import { VariableParser } from "./variable-parser";
import { gApp } from "../app.global";
import { parsers, availableParsers } from './parsers';
import * as _ from 'lodash';
import * as glob from 'glob';
import * as path from 'path';
import * as fs from 'fs-extra';

export class FileParser {
    private availableParsers = parsers;
    private globCache: any = {};

    constructor(private fuzzyService: FuzzyService) { }

    private get lang() {
        return gApp.lang.fileParser;
    }

    getAvailableParsers() {
        return availableParsers();
    }

    getParserInfo(key: string) {
        return this.availableParsers[key] ? this.availableParsers[key].getParserInfo() : undefined;
    }

    executeFileParser(configs: UserConfiguration[]) {
        let steamDirectories: { directory: string, useCredentials: boolean, data: userAccountData[] }[] = [];
        let totalUserAccountsFound: number = 0;
        let parsedConfigs: ParsedUserConfiguration[] = [];

        this.globCache = {};

        return Promise.resolve().then(() => {
            let promises: Promise<ParsedData>[] = [];
            for (let i = 0; i < configs.length; i++) {
                let parser = this.getParserInfo(configs[i].parserType);

                steamDirectories.push({ directory: configs[i].steamDirectory, useCredentials: configs[i].userAccounts.useCredentials, data: [] });

                if (parser) {
                    if (parser.inputs !== undefined) {
                        for (var inputName in parser.inputs) {
                            if (parser.inputs[inputName].forcedInput)
                                configs[i].parserInputs[inputName] = parser.inputs[inputName].forcedInput;
                            else if (configs[i].parserInputs[inputName] === undefined)
                                configs[i].parserInputs[inputName] = '';
                        }
                    }
                    promises.push(this.availableParsers[configs[i].parserType].execute(configs[i].romDirectory, configs[i].parserInputs, this.globCache));
                }
                else
                    throw new Error(this.lang.error.parserNotFound__i.interpolate({ name: configs[i].parserType }));
            }
            return promises;
        }).then((parserPromises) => {
            return Promise.resolve().then(() => {
                if (steamDirectories.length) {
                    let availableLogins: Promise<userAccountData[]>[] = [];
                    for (let i = 0; i < steamDirectories.length; i++) {
                        availableLogins.push(getAvailableLogins(steamDirectories[i].directory, steamDirectories[i].useCredentials));
                    }
                    return Promise.all(availableLogins).then((data) => {
                        for (let i = 0; i < steamDirectories.length; i++) {
                            steamDirectories[i].data = data[i];
                        }
                    });
                }
            }).then(() => {
                return parserPromises;
            });
        }).then((parserPromises) => {
            return Promise.all(parserPromises);
        }).then((data: ParsedDataWithFuzzy[]) => {
            let localImagePromises: Promise<any>[] = [];
            let localIconPromises: Promise<any>[] = [];
            for (let i = 0; i < configs.length; i++) {
                if (configs[i].fuzzyMatch.use)
                    this.fuzzyService.fuzzyMatcher.fuzzyMatchParsedData(data[i], configs[i].fuzzyMatch.removeCharacters, configs[i].fuzzyMatch.removeBrackets);

                let userFilter = this.variableStringToArray(configs[i].userAccounts.specifiedAccounts);
                let filteredAccounts = this.filterUserAccounts(steamDirectories[i].data, userFilter, configs[i].steamDirectory, configs[i].userAccounts.skipWithMissingDataDir);

                totalUserAccountsFound += filteredAccounts.found.length;

                parsedConfigs.push({
                    steamCategories: this.variableStringToArray(configs[i].steamCategory),
                    appendArgsToExecutable: configs[i].appendArgsToExecutable,
                    imageProviders: configs[i].imageProviders,
                    foundUserAccounts: filteredAccounts.found,
                    missingUserAccounts: filteredAccounts.missing,
                    steamDirectory: configs[i].steamDirectory,
                    files: [],
                    failed: []
                });

                for (let j = 0; j < data[i].success.length; j++) {
                    let fuzzyTitle = data[i].success[j].fuzzyTitle || data[i].success[j].extractedTitle;
                    let executableLocation = configs[i].executableLocation ? configs[i].executableLocation : data[i].success[j].filePath;

                    parsedConfigs[i].files.push({
                        executableLocation: executableLocation,
                        startInDirectory: configs[i].startInDirectory.length > 0 ? configs[i].startInDirectory : path.dirname(executableLocation),
                        argumentString: '',
                        resolvedLocalImages: [],
                        localImages: [],
                        resolvedLocalIcons: [],
                        localIcons: [],
                        fuzzyTitle: fuzzyTitle,
                        extractedTitle: data[i].success[j].extractedTitle,
                        finalTitle: configs[i].titleModifier.replace(/\${title}/gi, data[i].success[j].extractedTitle),
                        fuzzyFinalTitle: configs[i].titleModifier.replace(/\${title}/gi, fuzzyTitle),
                        filePath: data[i].success[j].filePath,
                        onlineImageQueries: undefined
                    });

                    let lastFile = parsedConfigs[i].files[parsedConfigs[i].files.length - 1];
                    lastFile.onlineImageQueries = this.variableStringToArray(this.replaceVariables(configs[i].onlineImageQueries, this.makeVariableData(configs[i], lastFile), 1), true);
                }

                parsedConfigs[i].failed = _.cloneDeep(data[i].failed);

                this.parseExecutableArgs(configs[i], parsedConfigs[i]);
                localImagePromises.push(this.resolveFieldGlobs('localImages', configs[i], parsedConfigs[i]).then((data) => {
                    for (let j = 0; j < data.parsedConfig.files.length; j++) {
                        data.parsedConfig.files[j].resolvedLocalImages = data.resolvedGlobs[j];

                        let extRegex = /png|tga|jpg|jpeg/i;
                        data.parsedConfig.files[j].localImages = data.resolvedFiles[j].filter((item) => {
                            return extRegex.test(path.extname(item));
                        }).map((item) => {
                            return encodeURI(`file:///${item.replace(/\\/g, '/')}`);
                        });
                    }
                }));
                localIconPromises.push(this.resolveFieldGlobs('localIcons', configs[i], parsedConfigs[i]).then((data) => {
                    for (let j = 0; j < data.parsedConfig.files.length; j++) {
                        data.parsedConfig.files[j].resolvedLocalIcons = data.resolvedGlobs[j];
                        data.parsedConfig.files[j].localIcons = data.resolvedFiles[j];
                    }
                }));
            }
            return Promise.all(localImagePromises).then(() => Promise.all(localIconPromises));
        }).then(() => {
            return { parsedConfigs, noUserAccounts: totalUserAccountsFound === 0 };
        });
    }

    private variableStringToArray(input: string, uniqueOnly: boolean = false) {
        let vParser = new VariableParser('${', '}');
        let parsedData = vParser.setInput(input).parse() ? _.pull(vParser.getContents(true), '') : [];
        if (uniqueOnly) {
            return _.uniq(parsedData);
        }
        else
            return parsedData;
    }

    private filterUserAccounts(accountData: userAccountData[], nameFilter: string[], steamDirectory: string, skipWithMissingDirectories: boolean) {
        let data: { found: userAccountData[], missing: string[] } = { found: [], missing: [] };

        if (nameFilter.length === 0) {
            nameFilter = _.map(accountData, 'name');
        }

        if (nameFilter.length > 0) {
            for (let i = 0; i < nameFilter.length; i++) {
                let index = accountData.findIndex((item) => item.name === nameFilter[i]);
                if (index !== -1) {
                    if (skipWithMissingDirectories) {
                        let accountPath = path.join(steamDirectory, 'userdata', accountData[index].accountID);
                        if (!this.validatePath(accountPath, true))
                            continue;
                    }
                    data.found.push(accountData[index]);
                }
                else
                    data.missing.push(nameFilter[i]);
            }
        }
        return data;
    }

    private parseExecutableArgs(config: UserConfiguration, parsedConfig: ParsedUserConfiguration) {
        for (let i = 0; i < parsedConfig.files.length; i++) {
            parsedConfig.files[i].argumentString = this.replaceVariables(config.executableArgs, this.makeVariableData(config, parsedConfig.files[i]));
        }
    }

    private resolveFieldGlobs(field: string, config: UserConfiguration, parsedConfig: ParsedUserConfiguration) {
        let promises: Promise<void>[] = [];
        let resolvedGlobs: string[][] = [];
        let resolvedFiles: string[][] = [];

        for (let i = 0; i < parsedConfig.files.length; i++) {
            resolvedGlobs.push([]);
            resolvedFiles.push([]);

            let fieldValue = config[field];
            if (fieldValue) {
                let expandableSet = /\$\((\${.+?})(?:\|(.+))?\)\$/.exec(fieldValue);

                if (expandableSet === null) {
                    let replacedGlob = path.resolve(config.romDirectory, this.replaceVariables(fieldValue, this.makeVariableData(config, parsedConfig.files[i]))).replace(/\\/g, '/');
                    resolvedGlobs[i].push(replacedGlob);

                    promises.push(this.globPromise(replacedGlob, { silent: true, dot: true, realpath: true, cwd: config.romDirectory, cache: this.globCache }).then((files) => {
                        resolvedFiles[i] = files;
                    }));
                }
                else {
                    let secondaryMatch: string = undefined;
                    let parserMatch = fieldValue.replace(expandableSet[0], '$()$');
                    parserMatch = this.replaceVariables(parserMatch, this.makeVariableData(config, parsedConfig.files[i]));
                    parserMatch = path.resolve(config.romDirectory, parserMatch.replace('$()$', expandableSet[1])).replace(/\\/g, '/');
                    resolvedGlobs[i].push(parserMatch);

                    if (expandableSet[2]) {
                        secondaryMatch = fieldValue.replace(expandableSet[0], expandableSet[2]);
                        secondaryMatch = path.resolve(config.romDirectory, this.replaceVariables(secondaryMatch, this.makeVariableData(config, parsedConfig.files[i]))).replace(/\\/g, '/');
                    }

                    promises.push(Promise.resolve().then(() => {
                        if (/\${title}/i.test(expandableSet[1]))
                            return this.availableParsers['Glob'].execute(config.romDirectory, { 'glob': parserMatch }, this.globCache);
                        else
                            return this.availableParsers['Glob-regex'].execute(config.romDirectory, { 'glob-regex': parserMatch }, this.globCache);
                    }).then((parsedData) => {
                        for (let j = 0; j < parsedData.success.length; j++) {
                            if (config.fuzzyMatch.use) {
                                if (this.fuzzyService.fuzzyMatcher.fuzzyMatchString(parsedData.success[j].extractedTitle, config.fuzzyMatch.removeCharacters, config.fuzzyMatch.removeBrackets) === parsedConfig.files[i].fuzzyTitle) {
                                    resolvedFiles[i].push(parsedData.success[j].filePath);
                                }
                            }
                            else if (parsedData.success[j].extractedTitle === parsedConfig.files[i].extractedTitle) {
                                resolvedFiles[i].push(parsedData.success[j].filePath);
                            }
                        }
                        if (secondaryMatch !== undefined) {
                            return this.globPromise(secondaryMatch, { silent: true, dot: true, realpath: true, cwd: config.romDirectory, cache: this.globCache }).then((files) => {
                                return resolvedFiles[i].concat(files);
                            });
                        }
                        else
                            return resolvedFiles[i];
                    }).then((files) => {
                        resolvedFiles[i] = _.uniq(files);
                    }));
                }
            }
        }
        return Promise.all(promises).then(() => {
            return { config, parsedConfig, resolvedGlobs, resolvedFiles };
        });
    }

    private replaceVariables(input: string, data: ParserVariableData, depthLevel: number = 0) {
        let vParser = new VariableParser('${', '}');

        if (vParser.setInput(input).parse(depthLevel)) {
            let variables = vParser.getContents(false);
            for (let i = 0; i < variables.length; i++) {
                variables[i] = this.getVariable(variables[i] as AllVariables, data);
            }
            return vParser.replaceVariables(variables);
        }
        else
            return input;
    }

    private getVariable(variable: AllVariables, data: ParserVariableData) {
        let output = variable as string;
        switch (<AllVariables>variable.toUpperCase()) {
            case '/':
                output = path.sep;
                break;
            case 'EXEDIR':
                output = path.dirname(data.executableLocation);
                break;
            case 'EXEEXT':
                output = path.extname(data.executableLocation);
                break;
            case 'EXENAME':
                output = path.basename(data.executableLocation, path.extname(data.executableLocation));
                break;
            case 'EXEPATH':
                output = data.executableLocation;
                break;
            case 'FILEDIR':
                output = path.dirname(data.filePath);
                break;
            case 'FILEEXT':
                output = path.extname(data.filePath);
                break;
            case 'FILENAME':
                output = path.basename(data.filePath, path.extname(data.filePath));
                break;
            case 'FILEPATH':
                output = data.filePath;
                break;
            case 'FINALTITLE':
                output = data.finalTitle;
                break;
            case 'FUZZYFINALTITLE':
                output = data.fuzzyFinalTitle;
                break;
            case 'FUZZYTITLE':
                output = data.fuzzyTitle;
                break;
            case 'ROMDIR':
                output = data.romDirectory;
                break;
            case 'STARTINDIR':
                output = data.startInDirectory;
                break;
            case 'STEAMDIR':
                output = data.steamDirectory;
                break;
            case 'TITLE':
                output = data.extractedTitle;
                break;
            default:
                break;
        }
        return output;
    }

    private makeVariableData(config: UserConfiguration, parsedConfigFile: ParsedUserConfigurationFile) {
        return <ParserVariableData>{
            executableLocation: parsedConfigFile.executableLocation,
            startInDirectory: parsedConfigFile.startInDirectory,
            extractedTitle: parsedConfigFile.extractedTitle,
            steamDirectory: config.steamDirectory,
            filePath: parsedConfigFile.filePath,
            finalTitle: parsedConfigFile.finalTitle,
            fuzzyFinalTitle: parsedConfigFile.fuzzyFinalTitle,
            fuzzyTitle: parsedConfigFile.fuzzyTitle,
            romDirectory: config.romDirectory
        }
    }

    private validatePath(fsPath: string, checkForDirectory: boolean) {
        try {
            let path = fs.statSync(fsPath);
            return checkForDirectory ? path.isDirectory() : path.isFile();
        } catch (e) {
            return false;
        }
    }

    private globPromise(pattern: string, options: glob.IOptions) {
        return new Promise<string[]>((resolve, reject) => {
            glob(pattern, options, (err, files) => {
                if (err)
                    reject(err);
                else {
                    resolve(files);
                }
            });
        });
    }
}