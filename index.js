import Docker from 'dockerode';
import YAML from 'yaml';
import { createCA, createCert } from 'mkcert';
import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';

const options = {
    ca: {
        key: './files/ca/rootCA-key.pem',
        cert: './files/ca/rootCA.pem',
    },
    sites: {
        certs: './files/certs',
        tls: './files/traefik/tls.yml',
    },
};

let ca = {
    key: await readFile(options.ca.key, 'utf-8').catch(() => void 0),
    cert: await readFile(options.ca.cert, 'utf-8').catch(() => void 0),
};

if (!ca.key || !ca.cert) {
    ca = await createCA({
        countryCode: 'RW',
        organizationName: 'mkcert development CA',
        locality: 'Kigali',
        state: 'Kigali',
        validity: 365,
        organization: 'mkcert development',
    });

    await writeFile(options.ca.key, ca.key);
    console.log(`CA Private Key: ${options.ca.key}`);

    await writeFile(options.ca.cert, ca.cert);
    console.log(`CA Certificate: ${options.ca.cert}`);
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function generateCert(domains, ca) {
    return await createCert({
        ca: { cert: ca.cert, key: ca.key },
        email: 'admin@localhost',
        organization: 'mkcert development',
        domains: domains,
        validity: 365,
    });
}

async function checkLabelChanges() {
    /**
     * @typedef {Object} TLSCertificate
     * @property {string} certFile - Path to the certificate file.
     * @property {string} keyFile - Path to the key file.
     */

    /**
     * @typedef {Object} TLSConfig
     * @property {TLSCertificate[]} certificates - List of TLS certificates.
     */

    /**
     * @typedef {Object} TlsSchema
     * @property {TLSConfig} tls - TLS configuration.
     */

    try {
        const containers = await docker.listContainers({
            filters: {
                status: ['running'],
                label: ['traefik.enable=true', 'mkcert.domains'],
            },
        });

        /**
         * @type {Map<string, { cert: string, key: string }>}
         */
        const certificates = new Map();

        const certsInFolder = await readdir(`${options.sites.certs}`);
        /**
         * @type Record<string, string[]>
         */
        const existingCerts = certsInFolder.reduce((prev, cert) => {
            const [name] = cert.split('.');
            const key = name.replace('-key', '');
            if (!prev[key]) {
                prev[key] = [];
            }
            prev[key].push(cert);
            return prev;
        }, {});

        const obsoleteCerts = Object.entries(existingCerts).filter(
            ([key]) => containers.find((container) => container.Id === key) === undefined
        );

        for (const [key, certs] of obsoleteCerts) {
            for (const cert of certs) {
                console.log(`Removing obsolete certificate: ${key}`);
                await unlink(`${options.sites.certs}/${cert}`);
            }
        }

        for (const container of containers) {
            /** @type {TlsSchema} */
            const currentYmlContents = YAML.parse(await readFile(options.sites.tls, 'utf-8'));
            const containerIsInYml = currentYmlContents.tls.certificates.find(
                (x) => x.certFile === `${options.sites.certs}/${container.Id}.pem`
            );

            const names = {
                certFile: `${options.sites.certs}/${container.Id}.pem`,
                keyFile: `${options.sites.certs}/${container.Id}-key.pem`,
            };

            if (containerIsInYml === undefined) {
                const domains = new Set(container.Labels['mkcert.domains'].split(',').map((domain) => domain.trim()));

                const certs = await generateCert([...domains.values()], ca);

                console.log(`Creating Certificate for ${container.Names[0]}`);
                await writeFile(names.certFile, certs.cert);
                console.log(`Certificate: ${names.certFile}`);

                await writeFile(names.keyFile, certs.key);
                console.log(`Private Key: ${names.keyFile}`);
            }

            certificates.set(container.Id, names);
        }

        const yamlContents = YAML.stringify({
            tls: {
                certificates: [...certificates.values()],
            },
        });

        await writeFile(options.sites.tls, yamlContents);
    } catch (error) {
        console.error('Error checking label changes:', error);
    }
}

// Run periodic label check every 10 seconds
while (true) {
    console.log('Checking for label changes...\n');

    await checkLabelChanges();

    await new Promise((resolve) => setTimeout(resolve, 10000));
}
