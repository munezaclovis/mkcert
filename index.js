import Docker from 'dockerode';
import YAML from 'yaml';
import forge from 'node-forge';

import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';

if (process.env.CERT_DIR === undefined) throw new Error('CERTS environment variable is required lol');

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
    let caKeys = forge.pki.rsa.generateKeyPair(4096);
    let caCert = forge.pki.createCertificate();

    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = '01';
    caCert.validity.notBefore = new Date();
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10); // 10-year validity

    const caAttrs = [
        { name: 'commonName', value: 'My Root CA' },
        { name: 'countryName', value: 'US' },
        { name: 'organizationName', value: 'My Company' },
        { name: 'organizationalUnitName', value: 'IT' },
    ];

    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);

    // Root CA is a Certificate Authority (CA)
    caCert.setExtensions([
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        { name: 'subjectKeyIdentifier', keyIdentifier: true },
    ]);

    caCert.sign(caKeys.privateKey, forge.md.sha256.create());

    const caCertPem = forge.pki.certificateToPem(caCert);
    const caKeyPem = forge.pki.privateKeyToPem(caKeys.privateKey);

    // Save Root CA Certificate and Key
    await writeFile(options.ca.cert, caCertPem);
    await writeFile(options.ca.key, caKeyPem);

    ca = {
        key: caKeyPem,
        cert: caCertPem,
    };
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function generateCert(domains, ca) {
    const caCert = forge.pki.certificateFromPem(ca.cert);
    const caKey = forge.pki.privateKeyFromPem(ca.key);

    const domainKeys = forge.pki.rsa.generateKeyPair(2048);
    const domainCert = forge.pki.createCertificate();

    domainCert.publicKey = domainKeys.publicKey;
    domainCert.serialNumber = '03';
    domainCert.validity.notBefore = new Date();
    domainCert.validity.notAfter = new Date();
    domainCert.validity.notAfter.setFullYear(domainCert.validity.notBefore.getFullYear() + 1); // 1-year validity

    // Set Subject for the domain certificate (Primary CN: one.example.com)
    const domainAttrs = [
        { name: 'commonName', value: domains[0] },
        { name: 'countryName', value: 'US' },
        { name: 'organizationName', value: 'My Company' },
        { name: 'organizationalUnitName', value: 'Web Services' },
    ];

    domainCert.setSubject(domainAttrs);
    domainCert.setIssuer(caCert.subject.attributes);

    // Add Subject Alternative Names (SAN) for `one.example.com` and `*.example.com`
    const altNames = domains.map((domain) => ({ type: 2, value: domain }));
    domainCert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', keyCertSign: false, digitalSignature: true, keyEncipherment: true },
        { name: 'subjectAltName', altNames },
    ]);

    // Sign the domain certificate using the Root CA
    domainCert.sign(caKey, forge.md.sha256.create());

    // Convert to PEM format
    const domainCertPem = forge.pki.certificateToPem(domainCert);
    const domainKeyPem = forge.pki.privateKeyToPem(domainKeys.privateKey);

    // Save Domain Certificate and Key
    return {
        cert: domainCertPem,
        key: domainKeyPem,
    };
}

async function checkLabelChanges() {
    /**
     * @typedef {Object} TLSCertificate
     * @property {string} certFile - Path to the certificate file.
     * @property {string} keyFile - Path to the key file.
     * @property {string[]} stores - List of stores.
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
         * @type {Map<string, { certFile: string, keyFile: string }>}
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
            const containerIsInYml = currentYmlContents?.tls?.certificates?.find(
                (x) => x.certFile === `${process.env.CERT_DIR}/${container.Id}.pem`
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
                certificates: [...certificates.values()].map((x) => {
                    return {
                        certFile: x.certFile
                            .replace(`${options.sites.certs}`, process.env.CERT_DIR)
                            .replaceAll('//', '/'),
                        keyFile: x.keyFile
                            .replace(`${options.sites.certs}`, process.env.CERT_DIR)
                            .replaceAll('//', '/'),
                        stores: ['default'],
                    };
                }),
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

    await new Promise((resolve) => setTimeout(resolve, process.env.CHECK_INTERVAL || 10000));
}
